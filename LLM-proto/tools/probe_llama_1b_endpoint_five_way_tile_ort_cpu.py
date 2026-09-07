#!/usr/bin/env python3
"""Run diagnostic CPU ORT semantics for 5-way cross-artifact endpoint tiles.

This S0 helper for issue #223 exercises only the 8-way execution tiles that
cross a physical-artifact boundary in the diagnostic 5-way (~200 MiB) layout.
Each logical tile is assembled inside ONNX from two independently opened
physical payload files using external-data offsets plus Concat, then consumed by
embedding Gather and logits Transpose+MatMul. It does not select the 5-way
layout or establish browser/WebGPU, cache, manifest, scheduling, or full-model
numerical semantics.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import mmap
import os
from pathlib import Path
import platform
import tempfile
import time

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper

import probe_llama_1b_endpoint_layout_candidates as layout_probe
import probe_llama_1b_endpoint_preferred_tile_ort_cpu as preferred_probe


REPORT_KIND = "unzen-pinned-llama-1b-endpoint-five-way-tile-ort-cpu-probe"
REPORT_SCHEMA_VERSION = "1.0.0"
PINNED_ORT_VERSION = preferred_probe.PINNED_ORT_VERSION
PHYSICAL_ARTIFACT_COUNT = 5
EXECUTION_TILE_COUNT = 8
FLOAT32_BYTES = preferred_probe.FLOAT32_BYTES
ATOL = preferred_probe.ATOL
RTOL = preferred_probe.RTOL


def _sha256_fd_range(fd: int, *, offset: int, length: int) -> str:
    if offset < 0 or length <= 0:
        raise RuntimeError("source range must have non-negative offset and positive length")
    digest = hashlib.sha256()
    cursor = 0
    while cursor < length:
        chunk = os.pread(fd, min(8 * 1024 * 1024, length - cursor), offset + cursor)
        if not chunk:
            raise RuntimeError("unexpected EOF while hashing pinned source range")
        digest.update(chunk)
        cursor += len(chunk)
    return digest.hexdigest()


def _required_int(value: object, *, field: str, minimum: int = 0) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise RuntimeError(f"{field} must be an integer >= {minimum}")
    return value


def _physical_slice_geometry(
    physical_slice: dict[str, object], *, tile_index: int
) -> tuple[int, int, int, int]:
    artifact_index = _required_int(
        physical_slice.get("physicalArtifactIndex"),
        field=f"tile[{tile_index}].physicalArtifactIndex",
    )
    row_count = _required_int(
        physical_slice.get("rowCount"),
        field=f"tile[{tile_index}].rowCount",
        minimum=1,
    )
    artifact_byte_offset = _required_int(
        physical_slice.get("artifactByteOffset"),
        field=f"tile[{tile_index}].artifactByteOffset",
    )
    byte_length = _required_int(
        physical_slice.get("byteLength"),
        field=f"tile[{tile_index}].byteLength",
        minimum=1,
    )
    return artifact_index, row_count, artifact_byte_offset, byte_length


def _save_external_model(
    *,
    tile: dict[str, object],
    hidden_size: int,
    mode: str,
    payload_fds: dict[int, int],
) -> Path:
    tile_index = _required_int(tile.get("tileIndex"), field="tileIndex")
    slices = tile.get("physicalSlices")
    if not isinstance(slices, list) or len(slices) != 2:
        raise RuntimeError("5-way boundary-crossing tile must map to exactly two physical slices")

    initializer_names: list[str] = []
    initializers: list[TensorProto] = []
    expected_rows = _required_int(tile.get("rowCount"), field="tile.rowCount", minimum=1)
    observed_rows = 0
    for slice_index, value in enumerate(slices):
        if not isinstance(value, dict):
            raise RuntimeError(f"tile[{tile_index}].physicalSlices[{slice_index}] must be an object")
        artifact_index, row_count, artifact_byte_offset, byte_length = _physical_slice_geometry(
            value, tile_index=tile_index
        )
        payload_fd = payload_fds.get(artifact_index)
        if payload_fd is None:
            raise RuntimeError(
                f"tile {tile_index} references unopened physical artifact {artifact_index}"
            )
        name = f"tile_weight_slice_{slice_index}"
        initializers.append(
            preferred_probe._external_weight_tensor(
                name=name,
                rows=row_count,
                hidden_size=hidden_size,
                payload_location=f"/dev/fd/{payload_fd}",
                payload_offset_bytes=artifact_byte_offset,
                byte_length=byte_length,
            )
        )
        initializer_names.append(name)
        observed_rows += row_count

    if observed_rows != expected_rows:
        raise RuntimeError(
            f"tile {tile_index} slice rows do not reconstruct tile rows: "
            f"expected {expected_rows}, got {observed_rows}"
        )

    nodes = [helper.make_node("Concat", initializer_names, ["tile_weight"], axis=0)]
    if mode == "embedding":
        model_input = helper.make_tensor_value_info("local_ids", TensorProto.INT64, [None])
        model_output = helper.make_tensor_value_info(
            "embedding", TensorProto.FLOAT, [None, hidden_size]
        )
        nodes.append(
            helper.make_node("Gather", ["tile_weight", "local_ids"], ["embedding"], axis=0)
        )
    elif mode == "logits":
        model_input = helper.make_tensor_value_info(
            "hidden", TensorProto.FLOAT, [1, hidden_size]
        )
        model_output = helper.make_tensor_value_info(
            "tile_logits", TensorProto.FLOAT, [1, expected_rows]
        )
        nodes.extend(
            [
                helper.make_node(
                    "Transpose", ["tile_weight"], ["tile_weight_transposed"], perm=[1, 0]
                ),
                helper.make_node(
                    "MatMul", ["hidden", "tile_weight_transposed"], ["tile_logits"]
                ),
            ]
        )
    else:
        raise RuntimeError(f"unsupported ORT tile mode: {mode}")

    graph = helper.make_graph(
        nodes,
        f"unzen-endpoint-five-way-tile-{mode}",
        [model_input],
        [model_output],
        initializers,
    )
    model = helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 21)],
        ir_version=10,
        producer_name="unzen-diagnostic",
    )
    handle = tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=f".unzen-endpoint-five-way-tile-{mode}-",
        suffix=".onnx",
        delete=False,
    )
    model_path = Path(handle.name)
    handle.close()
    onnx.save(model, model_path)
    return model_path


def _slice_view(
    *, payload_fd: int, artifact_byte_offset: int, rows: int, hidden_size: int
) -> tuple[mmap.mmap, np.ndarray]:
    mapped = mmap.mmap(payload_fd, length=0, access=mmap.ACCESS_READ)
    view = np.ndarray(
        shape=(rows, hidden_size),
        dtype="<f4",
        buffer=mapped,
        offset=artifact_byte_offset,
        order="C",
    )
    return mapped, view


def _expected_embedding(
    views: list[np.ndarray], local_ids: np.ndarray
) -> np.ndarray:
    boundaries: list[tuple[int, int, np.ndarray]] = []
    cursor = 0
    for view in views:
        end = cursor + int(view.shape[0])
        boundaries.append((cursor, end, view))
        cursor = end

    selected = []
    for raw_id in local_ids:
        local_id = int(raw_id)
        for start, end, view in boundaries:
            if start <= local_id < end:
                selected.append(np.asarray(view[local_id - start]).copy())
                break
        else:
            raise RuntimeError(f"local token id {local_id} is outside reconstructed tile")
    return np.stack(selected, axis=0)


def _expected_logits(
    views: list[np.ndarray], hidden: np.ndarray, columns: list[int]
) -> np.ndarray:
    parts: list[np.ndarray] = []
    for view in views:
        part = np.zeros((view.shape[0],), dtype=np.float32)
        for column in columns:
            part += np.asarray(view[:, column]) * hidden[0, column]
        parts.append(part)
    return np.concatenate(parts, axis=0)


def _execute_tile(
    *,
    tile: dict[str, object],
    hidden_size: int,
    payload_fds: dict[int, int],
) -> dict[str, object]:
    tile_index = _required_int(tile.get("tileIndex"), field="tileIndex")
    start_row = _required_int(tile.get("startRow"), field="tile.startRow")
    end_row = _required_int(
        tile.get("endRowExclusive"), field="tile.endRowExclusive", minimum=1
    )
    row_count = _required_int(tile.get("rowCount"), field="tile.rowCount", minimum=1)
    if end_row <= start_row or row_count != end_row - start_row:
        raise RuntimeError("5-way execution tile row geometry is invalid")
    slices = tile.get("physicalSlices")
    if not isinstance(slices, list) or len(slices) != 2:
        raise RuntimeError("5-way boundary-crossing tile must expose exactly two physical slices")

    mappings: list[mmap.mmap] = []
    views: list[np.ndarray] = []
    slice_report: list[dict[str, int]] = []
    try:
        for slice_index, value in enumerate(slices):
            if not isinstance(value, dict):
                raise RuntimeError(
                    f"tile[{tile_index}].physicalSlices[{slice_index}] must be an object"
                )
            artifact_index, slice_rows, artifact_offset, byte_length = _physical_slice_geometry(
                value, tile_index=tile_index
            )
            payload_fd = payload_fds.get(artifact_index)
            if payload_fd is None:
                raise RuntimeError(
                    f"tile {tile_index} references unopened physical artifact {artifact_index}"
                )
            mapped, view = _slice_view(
                payload_fd=payload_fd,
                artifact_byte_offset=artifact_offset,
                rows=slice_rows,
                hidden_size=hidden_size,
            )
            mappings.append(mapped)
            views.append(view)
            slice_report.append(
                {
                    "physicalArtifactIndex": artifact_index,
                    "rowCount": slice_rows,
                    "artifactByteOffset": artifact_offset,
                    "byteLength": byte_length,
                }
            )

        if sum(view.shape[0] for view in views) != row_count:
            raise RuntimeError("5-way physical slices do not cover the execution tile exactly")

        local_ids = np.array(sorted({0, row_count // 2, row_count - 1}), dtype=np.int64)
        expected_embedding = _expected_embedding(views, local_ids)
        embedding_model = _save_external_model(
            tile=tile,
            hidden_size=hidden_size,
            mode="embedding",
            payload_fds=payload_fds,
        )
        try:
            embedding_session, embedding_create_ms = preferred_probe._session(embedding_model)
            started = time.perf_counter()
            actual_embedding = embedding_session.run(None, {"local_ids": local_ids})[0]
            embedding_run_ms = (time.perf_counter() - started) * 1000.0
            embedding_exact = np.array_equal(actual_embedding, expected_embedding)
            embedding_max_abs = float(
                np.max(np.abs(actual_embedding - expected_embedding), initial=0.0)
            )
            if not embedding_exact:
                raise RuntimeError(
                    f"tile {tile_index} cross-artifact embedding Gather diverged; "
                    f"max abs diff={embedding_max_abs}"
                )
        finally:
            if "embedding_session" in locals():
                del embedding_session
            embedding_model.unlink(missing_ok=True)
            gc.collect()

        hidden = np.zeros((1, hidden_size), dtype=np.float32)
        columns: list[int] = []
        for candidate in (0, min(17, hidden_size - 1), hidden_size - 1):
            if candidate not in columns:
                columns.append(candidate)
        coefficients = [np.float32(0.5), np.float32(-0.25), np.float32(0.125)][
            : len(columns)
        ]
        for column, coefficient in zip(columns, coefficients, strict=True):
            hidden[0, column] = coefficient
        expected_logits = _expected_logits(views, hidden, columns)

        logits_model = _save_external_model(
            tile=tile,
            hidden_size=hidden_size,
            mode="logits",
            payload_fds=payload_fds,
        )
        try:
            logits_session, logits_create_ms = preferred_probe._session(logits_model)
            started = time.perf_counter()
            actual_logits = logits_session.run(None, {"hidden": hidden})[0][0]
            logits_run_ms = (time.perf_counter() - started) * 1000.0
            diff = np.abs(actual_logits - expected_logits)
            logits_max_abs = float(np.max(diff, initial=0.0))
            denominator = np.maximum(np.abs(expected_logits), np.float32(1e-12))
            logits_max_relative = float(np.max(diff / denominator, initial=0.0))
            logits_close = bool(np.allclose(actual_logits, expected_logits, atol=ATOL, rtol=RTOL))
            if not logits_close:
                raise RuntimeError(
                    f"tile {tile_index} cross-artifact logits MatMul diverged; "
                    f"max abs diff={logits_max_abs}, max relative diff={logits_max_relative}"
                )
        finally:
            if "logits_session" in locals():
                del logits_session
            logits_model.unlink(missing_ok=True)
            gc.collect()

        return {
            "tileIndex": tile_index,
            "startRow": start_row,
            "endRowExclusive": end_row,
            "rowCount": row_count,
            "physicalSlices": slice_report,
            "embedding": {
                "selectedGlobalTokenIds": [start_row + int(value) for value in local_ids],
                "selectedLocalTokenIds": [int(value) for value in local_ids],
                "exactEqual": embedding_exact,
                "maxAbsDiff": embedding_max_abs,
                "sessionCreateMs": embedding_create_ms,
                "runMs": embedding_run_ms,
            },
            "logits": {
                "sparseHiddenColumns": columns,
                "sparseHiddenCoefficients": [float(value) for value in coefficients],
                "allClose": logits_close,
                "atol": ATOL,
                "rtol": RTOL,
                "maxAbsDiff": logits_max_abs,
                "maxRelativeDiff": logits_max_relative,
                "sessionCreateMs": logits_create_ms,
                "runMs": logits_run_ms,
            },
        }
    finally:
        views.clear()
        for mapped in mappings:
            mapped.close()
        gc.collect()


def build_report(
    source_model_path: Path,
    source_external_data_path: Path,
    payload_root: Path,
    *,
    tile_indices: list[int] | None = None,
) -> dict[str, object]:
    if ort.__version__ != PINNED_ORT_VERSION:
        raise RuntimeError(
            f"onnxruntime version drift: expected {PINNED_ORT_VERSION}, got {ort.__version__}"
        )
    if os.name != "posix" or not Path("/dev/fd").is_dir():
        raise RuntimeError("pinned payload execution requires POSIX /dev/fd support")
    payload_root = payload_root.resolve()
    if not payload_root.is_dir():
        raise RuntimeError("payload root must be an existing directory")

    layout = layout_probe.build_report(source_model_path)
    if layout.get("kind") != layout_probe.REPORT_KIND:
        raise RuntimeError("unexpected upstream endpoint layout report kind")
    if layout.get("schemaVersion") != layout_probe.REPORT_SCHEMA_VERSION:
        raise RuntimeError("unexpected upstream endpoint layout report schema version")
    if layout.get("status") != "pass":
        raise RuntimeError("upstream endpoint layout report must pass")
    if layout.get("decisionStatus") != "diagnostic-only":
        raise RuntimeError("endpoint layout report must remain diagnostic-only")

    row_bytes = layout.get("rowBytes")
    if (
        not isinstance(row_bytes, int)
        or isinstance(row_bytes, bool)
        or row_bytes <= 0
        or row_bytes % FLOAT32_BYTES != 0
    ):
        raise RuntimeError("pinned endpoint rowBytes must describe float32 rows")
    hidden_size = row_bytes // FLOAT32_BYTES

    candidates = layout.get("candidates")
    if not isinstance(candidates, list):
        raise RuntimeError("endpoint layout candidates must be an array")
    selected_candidates = [
        candidate
        for candidate in candidates
        if isinstance(candidate, dict)
        and candidate.get("physicalArtifactCount") == PHYSICAL_ARTIFACT_COUNT
    ]
    if len(selected_candidates) != 1:
        raise RuntimeError("expected exactly one pinned 5-way candidate")
    candidate = selected_candidates[0]
    tiles = candidate.get("executionTiles")
    physical = candidate.get("physicalArtifacts")
    if not isinstance(tiles, list) or len(tiles) != EXECUTION_TILE_COUNT:
        raise RuntimeError("pinned 5-way candidate must expose exactly eight execution tiles")
    if not isinstance(physical, list) or len(physical) != PHYSICAL_ARTIFACT_COUNT:
        raise RuntimeError("pinned 5-way candidate must expose exactly five physical artifacts")

    crossing_indices = [
        index
        for index, tile in enumerate(tiles)
        if isinstance(tile, dict) and tile.get("physicalArtifactCount") == 2
    ]
    if len(crossing_indices) != 4:
        raise RuntimeError(
            f"pinned 5-way candidate boundary-crossing count drift: expected 4, got {len(crossing_indices)}"
        )
    selected_indices = crossing_indices if tile_indices is None else tile_indices
    if not selected_indices:
        raise RuntimeError("at least one boundary-crossing execution tile must be selected")
    if len(set(selected_indices)) != len(selected_indices):
        raise RuntimeError("execution tile selection must not contain duplicates")

    selected_tiles: list[dict[str, object]] = []
    for tile_index in selected_indices:
        if not isinstance(tile_index, int) or isinstance(tile_index, bool):
            raise RuntimeError("execution tile index must be an integer")
        if tile_index not in crossing_indices:
            raise RuntimeError(
                f"execution tile {tile_index} is not a pinned 5-way boundary-crossing tile"
            )
        tile = tiles[tile_index]
        if not isinstance(tile, dict) or tile.get("tileIndex") != tile_index:
            raise RuntimeError(f"execution tile index contract drift at {tile_index}")
        selected_tiles.append(tile)

    physical_by_index: dict[int, dict[str, object]] = {}
    for artifact in physical:
        if not isinstance(artifact, dict):
            raise RuntimeError("physical artifact entry must be an object")
        index = _required_int(artifact.get("index"), field="physical artifact index")
        if index in physical_by_index:
            raise RuntimeError(f"duplicate physical artifact index {index}")
        physical_by_index[index] = artifact

    required_indices = sorted(
        {
            int(physical_slice["physicalArtifactIndex"])
            for tile in selected_tiles
            for physical_slice in tile["physicalSlices"]
        }
    )

    source_identity = layout.get("pinnedSourceExternalDataIdentity")
    if not isinstance(source_identity, dict):
        raise RuntimeError("pinnedSourceExternalDataIdentity must be an object")
    source_bytes = _required_int(
        source_identity.get("bytes"), field="pinned source bytes", minimum=1
    )
    source_sha256 = source_identity.get("sha256")
    if not isinstance(source_sha256, str) or len(source_sha256) != 64:
        raise RuntimeError("pinned source SHA-256 must be a 64-character string")
    source_fd, verified_source, source_pinned_identity = preferred_probe._open_pinned_payload(
        source_external_data_path,
        expected_bytes=source_bytes,
        expected_sha256=source_sha256,
    )
    verified_source["role"] = "pinned-source-external-data"

    verified_payloads: list[dict[str, object]] = []
    pinned_payloads: dict[int, tuple[int, Path, tuple[int, int, int, int, int]]] = {}
    try:
        for index in required_indices:
            artifact = physical_by_index.get(index)
            if artifact is None:
                raise RuntimeError(f"execution tile references unknown physical artifact {index}")
            byte_length = _required_int(
                artifact.get("byteLength"), field=f"physical artifact {index} byteLength", minimum=1
            )
            source_offset = _required_int(
                artifact.get("sourceOffsetBytes"),
                field=f"physical artifact {index} sourceOffsetBytes",
            )
            source_end = _required_int(
                artifact.get("sourceEndOffsetBytesExclusive"),
                field=f"physical artifact {index} sourceEndOffsetBytesExclusive",
                minimum=1,
            )
            if source_end - source_offset != byte_length or source_end > source_bytes:
                raise RuntimeError(
                    f"physical artifact {index} source range does not match byteLength"
                )
            expected_sha256 = _sha256_fd_range(
                source_fd, offset=source_offset, length=byte_length
            )
            payload_path = payload_root / f"payload-{index:04d}.bin"
            fd, verified, pinned_identity = preferred_probe._open_pinned_payload(
                payload_path,
                expected_bytes=byte_length,
                expected_sha256=expected_sha256,
            )
            verified["physicalArtifactIndex"] = index
            verified["sourceOffsetBytes"] = source_offset
            verified["sourceEndOffsetBytesExclusive"] = source_end
            verified["matchesPinnedSourceRange"] = True
            verified_payloads.append(verified)
            pinned_payloads[index] = (fd, payload_path, pinned_identity)

        payload_fds = {index: value[0] for index, value in pinned_payloads.items()}
        tile_results = [
            _execute_tile(tile=tile, hidden_size=hidden_size, payload_fds=payload_fds)
            for tile in selected_tiles
        ]

        for _, payload_path, pinned_identity in pinned_payloads.values():
            preferred_probe._assert_payload_path_identity(
                payload_path, pinned_identity=pinned_identity
            )
        preferred_probe._assert_payload_path_identity(
            source_external_data_path, pinned_identity=source_pinned_identity
        )

        return {
            "schemaVersion": REPORT_SCHEMA_VERSION,
            "kind": REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "upstreamProbe": {
                "kind": layout.get("kind"),
                "schemaVersion": layout.get("schemaVersion"),
            },
            "sourceGraphSha256": layout.get("sourceGraphSha256"),
            "pinnedSourceExternalDataIdentity": layout.get(
                "pinnedSourceExternalDataIdentity"
            ),
            "physicalArtifactCount": PHYSICAL_ARTIFACT_COUNT,
            "executionTileCount": EXECUTION_TILE_COUNT,
            "boundaryCrossingTileIndices": crossing_indices,
            "hiddenSize": hidden_size,
            "onnxruntime": {
                "version": ort.__version__,
                "provider": "CPUExecutionProvider",
            },
            "environment": {
                "pythonVersion": platform.python_version(),
                "numpyVersion": np.__version__,
                "onnxVersion": onnx.__version__,
                "system": platform.system(),
                "release": platform.release(),
                "machine": platform.machine(),
                "macOSVersion": platform.mac_ver()[0] or None,
            },
            "verifiedPinnedSourceExternalData": verified_source,
            "verifiedPhysicalPayloads": verified_payloads,
            "executedTiles": tile_results,
            "conclusion": (
                "The selected boundary-crossing tiles from the diagnostic 5-way layout "
                "ran tied-weight embedding Gather and logits Transpose+MatMul under pinned "
                "onnxruntime CPU while two independent physical payload files were supplied "
                "as external initializers and concatenated inside the temporary ONNX graph. "
                "This is stage-local CPU feasibility only: it does not select the 5-way "
                "architecture, prove ORT Web/WebGPU multi-artifact binding, measure browser "
                "working set/session release, establish final-norm/full-model equivalence, "
                "or define manifest/cache/runtime/dispatcher semantics."
            ),
        }
    finally:
        for fd, _, _ in pinned_payloads.values():
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.close(source_fd)
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path)
    parser.add_argument("source_external_data", type=Path)
    parser.add_argument("payload_root", type=Path)
    parser.add_argument("--tile-index", type=int, action="append", dest="tile_indices")
    args = parser.parse_args()
    print(
        json.dumps(
            build_report(
                args.source_model,
                args.source_external_data,
                args.payload_root,
                tile_indices=args.tile_indices,
            ),
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
