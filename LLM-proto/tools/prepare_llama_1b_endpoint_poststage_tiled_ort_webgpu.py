#!/usr/bin/env python3
"""Prepare a complete diagnostic endpoint post-stage run for ORT Web/WebGPU.

The issue #223 architecture remains undecided. This helper binds the pinned
Llama-3.2-1B-Instruct q4 final norm to its exact 8 KiB source range and emits
eight vocabulary-row logits graphs backed by the existing four preferred-tier
physical payload ranges. It also computes a deterministic full-weight CPU ORT
reference from the pinned source topology so a real browser can compare the
complete final-norm output and complete [1, 1, 128256] logits tensor.

The browser is expected to execute the four physical payloads sequentially,
not to treat this preparation as an approved cache/runtime contract. This tool
does not select the 4-way physical layout, adopt 8-way execution, measure peak
host/GPU memory or reclamation, or alter artifact/runtime/dispatcher policy.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat

import numpy as np
import onnx
from onnx import TensorProto, helper

import prepare_llama_1b_endpoint_preferred_tile_ort_webgpu as preferred_webgpu
import probe_llama_1b_endpoint_layout_candidates as layout_probe
import probe_llama_1b_endpoint_poststage_tiled_ort_cpu as poststage_cpu
import probe_llama_1b_endpoint_preferred_tile_ort_cpu as preferred_cpu


REPORT_KIND = "unzen-pinned-llama-1b-endpoint-poststage-tiled-ort-webgpu-preparation"
REPORT_SCHEMA_VERSION = "1.0.0"
PHYSICAL_ARTIFACT_COUNT = 4
EXECUTION_TILE_COUNT = 8
FLOAT32_BYTES = 4
ORT_WEB_VERSION = preferred_webgpu.ORT_WEB_VERSION
EXPECTED_FINAL_NORM_WEIGHT_SHA256 = (
    "af89374a4f1edc09ec38496e36efb1663713bc0e44026b8ef9d9d13aac99e75e"
)


def _require_int(value: object, *, field: str, positive: bool = False) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise RuntimeError(f"{field} must be an integer")
    if positive and value <= 0:
        raise RuntimeError(f"{field} must be positive")
    if not positive and value < 0:
        raise RuntimeError(f"{field} must be non-negative")
    return value


def _ensure_empty_output_dir(output_dir: Path) -> None:
    if output_dir.exists() or output_dir.is_symlink():
        snapshot = output_dir.lstat()
        if stat.S_ISLNK(snapshot.st_mode) or not stat.S_ISDIR(snapshot.st_mode):
            raise RuntimeError("output directory must be a real directory, not a symlink")
        if any(output_dir.iterdir()):
            raise RuntimeError("output directory must be empty")
    else:
        output_dir.mkdir(parents=True)


def _copy_fd_range(
    source_fd: int,
    *,
    source_offset: int,
    length: int,
    destination: Path,
    expected_sha256: str | None = None,
) -> str:
    if source_offset < 0 or length <= 0:
        raise RuntimeError("source copy range must have non-negative offset and positive length")
    digest = hashlib.sha256()
    cursor = 0
    with destination.open("xb") as dst:
        while cursor < length:
            chunk = os.pread(
                source_fd,
                min(8 * 1024 * 1024, length - cursor),
                source_offset + cursor,
            )
            if not chunk:
                raise RuntimeError(f"unexpected EOF while materializing {destination.name}")
            dst.write(chunk)
            digest.update(chunk)
            cursor += len(chunk)
    actual = digest.hexdigest()
    if expected_sha256 is not None and actual != expected_sha256:
        destination.unlink(missing_ok=True)
        raise RuntimeError(
            f"{destination.name} SHA-256 mismatch: expected {expected_sha256}, got {actual}"
        )
    return actual


def _external_float_tensor(
    *, name: str, dims: list[int], location: str, offset: int, length: int
) -> TensorProto:
    expected = int(np.prod(dims)) * FLOAT32_BYTES
    if length != expected:
        raise RuntimeError(
            f"external tensor {name!r} byte length mismatch: expected {expected}, got {length}"
        )
    tensor = TensorProto()
    tensor.name = name
    tensor.data_type = TensorProto.FLOAT
    tensor.dims.extend(dims)
    tensor.data_location = TensorProto.EXTERNAL
    for key, value in (("location", location), ("offset", str(offset)), ("length", str(length))):
        entry = tensor.external_data.add()
        entry.key = key
        entry.value = value
    return tensor


def build_final_norm_model(*, hidden_size: int, epsilon: float, weight_bytes: int) -> onnx.ModelProto:
    initializer = _external_float_tensor(
        name=poststage_cpu.FINAL_NORM_INPUTS[2],
        dims=[hidden_size],
        location="final-norm-weight.bin",
        offset=0,
        length=weight_bytes,
    )
    inputs = [
        helper.make_tensor_value_info(
            poststage_cpu.FINAL_NORM_INPUTS[0], TensorProto.FLOAT, [1, 1, hidden_size]
        ),
        helper.make_tensor_value_info(
            poststage_cpu.FINAL_NORM_INPUTS[1], TensorProto.FLOAT, [1, 1, hidden_size]
        ),
    ]
    output = helper.make_tensor_value_info(
        poststage_cpu.FINAL_NORM_OUTPUT, TensorProto.FLOAT, [1, 1, hidden_size]
    )
    graph = helper.make_graph(
        [poststage_cpu._final_norm_node(epsilon)],
        "unzen-endpoint-poststage-webgpu-final-norm",
        inputs,
        [output],
        [initializer],
    )
    return helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 21), helper.make_opsetid("com.microsoft", 1)],
        ir_version=10,
        producer_name="unzen-diagnostic",
    )


def build_tile_logits_model(
    *, tile: dict[str, object], hidden_size: int, payload_file: str
) -> onnx.ModelProto:
    row_count = _require_int(tile.get("rowCount"), field="tile.rowCount", positive=True)
    slices = tile.get("physicalSlices")
    if not isinstance(slices, list) or len(slices) != 1 or not isinstance(slices[0], dict):
        raise RuntimeError("preferred 4-way execution tile must map to exactly one physical slice")
    sl = slices[0]
    artifact_offset = _require_int(
        sl.get("artifactByteOffset"), field="tile.physicalSlice.artifactByteOffset"
    )
    byte_length = _require_int(
        sl.get("byteLength"), field="tile.physicalSlice.byteLength", positive=True
    )
    if byte_length != row_count * hidden_size * FLOAT32_BYTES:
        raise RuntimeError("tile physical slice byte length does not match row geometry")
    initializer = _external_float_tensor(
        name="tile_weight",
        dims=[row_count, hidden_size],
        location=payload_file,
        offset=artifact_offset,
        length=byte_length,
    )
    normalized = helper.make_tensor_value_info(
        poststage_cpu.FINAL_NORM_OUTPUT, TensorProto.FLOAT, [1, 1, hidden_size]
    )
    logits = helper.make_tensor_value_info(
        "tile_logits", TensorProto.FLOAT, [1, 1, row_count]
    )
    nodes = [
        helper.make_node("Transpose", ["tile_weight"], ["tile_weight_t"], perm=[1, 0]),
        helper.make_node(
            "MatMul", [poststage_cpu.FINAL_NORM_OUTPUT, "tile_weight_t"], ["tile_logits"]
        ),
    ]
    graph = helper.make_graph(
        nodes,
        f"unzen-endpoint-poststage-webgpu-tile-{tile.get('tileIndex')}",
        [normalized],
        [logits],
        [initializer],
    )
    return helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 21)],
        ir_version=10,
        producer_name="unzen-diagnostic",
    )


def _write_f32(path: Path, array: np.ndarray) -> dict[str, object]:
    raw = np.ascontiguousarray(array, dtype="<f4").tobytes(order="C")
    path.write_bytes(raw)
    return {
        "file": path.name,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "shape": list(array.shape),
        "dtype": "float32-le",
    }


def _graph_info(path: Path) -> dict[str, object]:
    return {
        "file": path.name,
        "bytes": path.stat().st_size,
        "sha256": preferred_webgpu._sha256_file(path),
    }


def prepare(source_model: Path, source_external_data: Path, output_dir: Path) -> dict[str, object]:
    if poststage_cpu.ort.__version__ != poststage_cpu.PINNED_ORT_VERSION:
        raise RuntimeError(
            "onnxruntime version drift: "
            f"expected {poststage_cpu.PINNED_ORT_VERSION}, got {poststage_cpu.ort.__version__}"
        )
    if os.name != "posix" or not Path("/dev/fd").is_dir():
        raise RuntimeError("pinned post-stage reference preparation requires POSIX /dev/fd support")
    layout = layout_probe.build_report(source_model)
    rows, hidden_size, physical, tiles = poststage_cpu._validate_layout(layout)
    source_graph_sha256 = layout.get("sourceGraphSha256")
    if not isinstance(source_graph_sha256, str) or len(source_graph_sha256) != 64:
        raise RuntimeError("layout report sourceGraphSha256 is invalid")
    source_identity = layout.get("pinnedSourceExternalDataIdentity")
    if not isinstance(source_identity, dict):
        raise RuntimeError("layout report pinned source external-data identity is missing")
    if (
        source_identity.get("bytes") != preferred_webgpu.PINNED_EXTERNAL_DATA_BYTES
        or source_identity.get("sha256") != preferred_webgpu.PINNED_EXTERNAL_DATA_SHA256
    ):
        raise RuntimeError("pinned source external-data identity drifted")

    _ensure_empty_output_dir(output_dir)
    created: list[Path] = []
    source_model_fd = -1
    source_fd = -1
    reference_model: Path | None = None
    source_model_path_identity: tuple[int, int, int, int, int] | None = None
    source_path_identity: tuple[int, int, int, int, int] | None = None
    try:
        (
            source_model_fd,
            model,
            verified_source_graph,
            source_model_path_identity,
        ) = poststage_cpu._load_pinned_source_model(
            source_model, expected_sha256=source_graph_sha256
        )
        contract = poststage_cpu._poststage_contract(
            model, rows=rows, hidden_size=hidden_size
        )
        poststage_cpu._validate_pinned_poststage_offsets(contract)

        source_fd, verified_source, source_path_identity = preferred_cpu._open_pinned_payload(
            source_external_data,
            expected_bytes=preferred_webgpu.PINNED_EXTERNAL_DATA_BYTES,
            expected_sha256=preferred_webgpu.PINNED_EXTERNAL_DATA_SHA256,
        )
        verified_source["role"] = "pinned-source-external-data"

        physical_by_index: dict[int, dict[str, object]] = {}
        for artifact in physical:
            index = _require_int(artifact.get("index"), field="physical.index")
            if index in physical_by_index:
                raise RuntimeError(f"duplicate preferred physical artifact index {index}")
            physical_by_index[index] = artifact
        if sorted(physical_by_index) != list(range(PHYSICAL_ARTIFACT_COUNT)):
            raise RuntimeError("preferred physical artifacts must be indexed 0..3")

        manifest_artifacts: list[dict[str, object]] = []
        for index in range(PHYSICAL_ARTIFACT_COUNT):
            artifact = physical_by_index[index]
            source_offset = _require_int(
                artifact.get("sourceOffsetBytes"), field=f"physical[{index}].sourceOffsetBytes"
            )
            source_end = _require_int(
                artifact.get("sourceEndOffsetBytesExclusive"),
                field=f"physical[{index}].sourceEndOffsetBytesExclusive",
                positive=True,
            )
            byte_length = _require_int(
                artifact.get("byteLength"), field=f"physical[{index}].byteLength", positive=True
            )
            if source_end - source_offset != byte_length:
                raise RuntimeError(f"physical artifact {index} source range mismatch")
            expected_sha = preferred_cpu.PINNED_PREFERRED_PAYLOAD_SHA256.get(index)
            if expected_sha is None:
                raise RuntimeError(f"missing pinned preferred payload hash for artifact {index}")
            path = output_dir / f"payload-{index:04d}.bin"
            digest = _copy_fd_range(
                source_fd,
                source_offset=source_offset,
                length=byte_length,
                destination=path,
                expected_sha256=expected_sha,
            )
            created.append(path)
            manifest_artifacts.append(
                {
                    "index": index,
                    "file": path.name,
                    "bytes": byte_length,
                    "sha256": digest,
                    "sourceOffsetBytes": source_offset,
                    "sourceEndOffsetBytesExclusive": source_end,
                }
            )

        final_norm = contract["finalNorm"]
        if not isinstance(final_norm, dict) or not isinstance(final_norm.get("weight"), dict):
            raise RuntimeError("final norm contract is invalid")
        norm_weight = final_norm["weight"]
        norm_source_offset = _require_int(
            norm_weight.get("sourceOffsetBytes"), field="finalNorm.weight.sourceOffsetBytes"
        )
        norm_bytes = _require_int(
            norm_weight.get("byteLength"), field="finalNorm.weight.byteLength", positive=True
        )
        norm_path = output_dir / "final-norm-weight.bin"
        norm_sha = _copy_fd_range(
            source_fd,
            source_offset=norm_source_offset,
            length=norm_bytes,
            destination=norm_path,
            expected_sha256=EXPECTED_FINAL_NORM_WEIGHT_SHA256,
        )
        created.append(norm_path)
        norm_info = {
            "file": norm_path.name,
            "bytes": norm_bytes,
            "sha256": norm_sha,
            "sourceOffsetBytes": norm_source_offset,
            "sourceEndOffsetBytesExclusive": norm_source_offset + norm_bytes,
        }

        reference_model = poststage_cpu._build_reference_model(
            contract=contract,
            source_fd=source_fd,
            hidden_size=hidden_size,
            rows=rows,
        )
        feeds = poststage_cpu._inputs(hidden_size)
        reference_logits, reference_norm, reference_timing = poststage_cpu._run_model(
            reference_model, feeds
        )
        input_files: dict[str, dict[str, object]] = {}
        for key, name in (
            (poststage_cpu.FINAL_NORM_INPUTS[0], "residual.f32"),
            (poststage_cpu.FINAL_NORM_INPUTS[1], "update.f32"),
        ):
            path = output_dir / name
            input_files[key] = _write_f32(path, feeds[key])
            created.append(path)
        ref_norm_path = output_dir / "reference-final-norm.f32"
        ref_logits_path = output_dir / "reference-logits.f32"
        reference_files = {
            "finalNorm": _write_f32(ref_norm_path, reference_norm),
            "logits": _write_f32(ref_logits_path, reference_logits),
        }
        created.extend([ref_norm_path, ref_logits_path])

        epsilon = final_norm.get("epsilon")
        if not isinstance(epsilon, float):
            raise RuntimeError("final norm epsilon must be a float")
        final_norm_graph_path = output_dir / "final-norm.onnx"
        onnx.save_model(
            build_final_norm_model(
                hidden_size=hidden_size, epsilon=epsilon, weight_bytes=norm_bytes
            ),
            final_norm_graph_path,
        )
        onnx.checker.check_model(str(final_norm_graph_path), full_check=True)
        created.append(final_norm_graph_path)
        final_norm_graph = _graph_info(final_norm_graph_path)

        manifest_tiles: list[dict[str, object]] = []
        expected_start = 0
        for expected_index, tile in enumerate(tiles):
            if tile.get("tileIndex") != expected_index or tile.get("startRow") != expected_start:
                raise RuntimeError("execution tiles must be ordered and row-contiguous")
            row_count = _require_int(
                tile.get("rowCount"), field=f"tile[{expected_index}].rowCount", positive=True
            )
            end_row = _require_int(
                tile.get("endRowExclusive"),
                field=f"tile[{expected_index}].endRowExclusive",
                positive=True,
            )
            if end_row != expected_start + row_count:
                raise RuntimeError(f"execution tile {expected_index} row range mismatch")
            slices = tile.get("physicalSlices")
            if not isinstance(slices, list) or len(slices) != 1 or not isinstance(slices[0], dict):
                raise RuntimeError("4-way preferred execution tiles must map to one physical slice")
            sl = slices[0]
            artifact_index = _require_int(
                sl.get("physicalArtifactIndex"),
                field=f"tile[{expected_index}].physicalArtifactIndex",
            )
            if artifact_index not in physical_by_index:
                raise RuntimeError(f"tile {expected_index} references unknown physical artifact")
            artifact_offset = _require_int(
                sl.get("artifactByteOffset"),
                field=f"tile[{expected_index}].artifactByteOffset",
            )
            byte_length = _require_int(
                sl.get("byteLength"), field=f"tile[{expected_index}].byteLength", positive=True
            )
            artifact_bytes = _require_int(
                physical_by_index[artifact_index].get("byteLength"),
                field=f"physical[{artifact_index}].byteLength",
                positive=True,
            )
            if artifact_offset + byte_length > artifact_bytes:
                raise RuntimeError(f"tile {expected_index} exceeds physical artifact {artifact_index}")
            graph_path = output_dir / f"tile-{expected_index}-logits.onnx"
            onnx.save_model(
                build_tile_logits_model(
                    tile=tile,
                    hidden_size=hidden_size,
                    payload_file=f"payload-{artifact_index:04d}.bin",
                ),
                graph_path,
            )
            onnx.checker.check_model(str(graph_path), full_check=True)
            created.append(graph_path)
            manifest_tiles.append(
                {
                    "tileIndex": expected_index,
                    "startRow": expected_start,
                    "endRowExclusive": end_row,
                    "rowCount": row_count,
                    "physicalArtifactIndex": artifact_index,
                    "artifactByteOffset": artifact_offset,
                    "byteLength": byte_length,
                    "graph": _graph_info(graph_path),
                }
            )
            expected_start = end_row
        if expected_start != rows:
            raise RuntimeError(f"execution tiles do not cover full vocabulary: {expected_start} != {rows}")

        if source_model_path_identity is None or source_path_identity is None:
            raise RuntimeError("source identities were not pinned")
        preferred_cpu._assert_payload_path_identity(
            source_model, pinned_identity=source_model_path_identity
        )
        preferred_cpu._assert_payload_path_identity(
            source_external_data, pinned_identity=source_path_identity
        )

        manifest = {
            "schemaVersion": REPORT_SCHEMA_VERSION,
            "kind": REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": source_graph_sha256,
            "verifiedPinnedSourceGraph": verified_source_graph,
            "sourceExternalData": {
                "bytes": preferred_webgpu.PINNED_EXTERNAL_DATA_BYTES,
                "sha256": preferred_webgpu.PINNED_EXTERNAL_DATA_SHA256,
            },
            "physicalArtifactCount": PHYSICAL_ARTIFACT_COUNT,
            "executionTileCount": EXECUTION_TILE_COUNT,
            "rows": rows,
            "hiddenSize": hidden_size,
            "onnxruntimeWebVersion": ORT_WEB_VERSION,
            "referenceOnnxruntime": {
                "version": poststage_cpu.ort.__version__,
                "provider": "CPUExecutionProvider",
                **reference_timing,
            },
            "finalNorm": {
                "nodeName": final_norm.get("nodeName"),
                "opType": final_norm.get("opType"),
                "domain": final_norm.get("domain"),
                "epsilon": epsilon,
                "inputNames": list(poststage_cpu.FINAL_NORM_INPUTS[:2]),
                "outputName": poststage_cpu.FINAL_NORM_OUTPUT,
                "weight": norm_info,
                "graph": final_norm_graph,
            },
            "physicalArtifacts": manifest_artifacts,
            "tiles": manifest_tiles,
            "inputs": input_files,
            "referenceOutputs": reference_files,
            "sequentialExecution": {
                "physicalArtifactOrder": list(range(PHYSICAL_ARTIFACT_COUNT)),
                "tilesPerPhysicalArtifact": 2,
                "maximumWholePhysicalPayloadBytesPerStep": max(
                    int(item["bytes"]) for item in manifest_artifacts
                ),
                "totalPhysicalPayloadBytesVerifiedAcrossRun": sum(
                    int(item["bytes"]) for item in manifest_artifacts
                ),
            },
            "conclusion": (
                "Prepared a diagnostic-only complete browser post-stage experiment: one pinned "
                "final-norm graph plus eight logits tiles backed by four independently verified "
                "preferred physical payloads, with a deterministic pinned-source CPU ORT reference. "
                "The browser is expected to process physical payloads sequentially. This does not "
                "select the 4-way/8-way architecture, define production cache/runtime semantics, "
                "or measure/rely on immediate host/GPU memory reclamation."
            ),
        }
        manifest_path = output_dir / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        created.append(manifest_path)
        return manifest
    except Exception:
        for path in reversed(created):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    finally:
        if reference_model is not None:
            reference_model.unlink(missing_ok=True)
        if source_fd >= 0:
            os.close(source_fd)
        if source_model_fd >= 0:
            os.close(source_model_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path)
    parser.add_argument("source_external_data", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    report = prepare(
        args.source_model.absolute(),
        args.source_external_data.absolute(),
        args.output_dir.absolute(),
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
