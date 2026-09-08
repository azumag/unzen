#!/usr/bin/env python3
"""Prepare a diagnostic ORT Web/WebGPU 5-way cross-artifact endpoint probe.

Issue #223 leaves the 5-way (~200 MiB) layout unselected. This helper exercises
one representative 8-way execution tile (tile 1) whose tied-weight rows cross
physical artifacts 0 and 1. It verifies the complete pinned source external-data
file, materializes the two whole physical payloads from exact source ranges, and
emits embedding/logits ONNX graphs whose two external initializers are concatenated
inside the graph before Gather or Transpose+MatMul.

This is diagnostic-only. It does not select the 5-way layout, approve Concat as a
production strategy, define cache/runtime/dispatcher contracts, or establish
full-model numerical equivalence or browser working-set limits.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat

import onnx
from onnx import TensorProto, helper

import prepare_llama_1b_endpoint_preferred_tile_ort_webgpu as preferred_webgpu
import probe_llama_1b_endpoint_layout_candidates as layout_probe

REPORT_KIND = "unzen-pinned-llama-1b-endpoint-five-way-tile-ort-webgpu-preparation"
REPORT_SCHEMA_VERSION = "1.0.0"
PHYSICAL_ARTIFACT_COUNT = 5
EXECUTION_TILE_COUNT = 8
SELECTED_TILE_INDEX = 1
FLOAT32_BYTES = 4
ORT_WEB_VERSION = preferred_webgpu.ORT_WEB_VERSION


def _copy_source_range(source_fd: int, *, source_offset: int, length: int, destination: Path) -> str:
    digest = hashlib.sha256()
    cursor = 0
    with destination.open("xb") as dst:
        while cursor < length:
            chunk = os.pread(source_fd, min(8 * 1024 * 1024, length - cursor), source_offset + cursor)
            if not chunk:
                raise RuntimeError("unexpected EOF while materializing 5-way physical payload")
            dst.write(chunk)
            digest.update(chunk)
            cursor += len(chunk)
    return digest.hexdigest()


def _external_slice_tensor(*, name: str, file_name: str, rows: int, hidden_size: int, offset: int, length: int) -> TensorProto:
    expected = rows * hidden_size * FLOAT32_BYTES
    if length != expected:
        raise RuntimeError(f"external slice length mismatch: expected {expected}, got {length}")
    tensor = TensorProto()
    tensor.name = name
    tensor.data_type = TensorProto.FLOAT
    tensor.dims.extend([rows, hidden_size])
    tensor.data_location = TensorProto.EXTERNAL
    for key, value in (("location", file_name), ("offset", str(offset)), ("length", str(length))):
        item = tensor.external_data.add()
        item.key = key
        item.value = value
    return tensor


def build_probe_model(*, mode: str, hidden_size: int, tile_rows: int, slices: list[dict[str, object]]) -> onnx.ModelProto:
    if len(slices) != 2:
        raise RuntimeError("selected 5-way tile must contain exactly two physical slices")
    initializers: list[TensorProto] = []
    names: list[str] = []
    observed_rows = 0
    for index, sl in enumerate(slices):
        artifact_index = sl.get("physicalArtifactIndex")
        rows = sl.get("rowCount")
        offset = sl.get("artifactByteOffset")
        length = sl.get("byteLength")
        if not all(isinstance(value, int) and not isinstance(value, bool) for value in (artifact_index, rows, offset, length)):
            raise RuntimeError("invalid 5-way slice geometry")
        if rows <= 0 or offset < 0 or length <= 0:
            raise RuntimeError("invalid non-positive 5-way slice geometry")
        name = f"tile_weight_slice_{index}"
        initializers.append(_external_slice_tensor(
            name=name,
            file_name=f"payload-{artifact_index:04d}.bin",
            rows=rows,
            hidden_size=hidden_size,
            offset=offset,
            length=length,
        ))
        names.append(name)
        observed_rows += rows
    if observed_rows != tile_rows:
        raise RuntimeError(f"slice rows do not reconstruct tile rows: expected {tile_rows}, got {observed_rows}")

    nodes = [helper.make_node("Concat", names, ["tile_weight"], axis=0)]
    if mode == "embedding":
        model_input = helper.make_tensor_value_info("local_ids", TensorProto.INT64, [None])
        model_output = helper.make_tensor_value_info("embedding", TensorProto.FLOAT, [None, hidden_size])
        nodes.append(helper.make_node("Gather", ["tile_weight", "local_ids"], ["embedding"], axis=0))
    elif mode == "logits":
        model_input = helper.make_tensor_value_info("hidden", TensorProto.FLOAT, [1, hidden_size])
        model_output = helper.make_tensor_value_info("tile_logits", TensorProto.FLOAT, [1, tile_rows])
        nodes.extend([
            helper.make_node("Transpose", ["tile_weight"], ["tile_weight_transposed"], perm=[1, 0]),
            helper.make_node("MatMul", ["hidden", "tile_weight_transposed"], ["tile_logits"]),
        ])
    else:
        raise RuntimeError(f"unsupported mode: {mode}")

    graph = helper.make_graph(nodes, f"unzen-endpoint-five-way-webgpu-{mode}", [model_input], [model_output], initializers)
    return helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 21)],
        ir_version=10,
        producer_name="unzen-diagnostic",
    )


def prepare(source_model: Path, source_external_data: Path, output_dir: Path) -> dict[str, object]:
    layout = layout_probe.build_report(source_model)
    if layout.get("kind") != layout_probe.REPORT_KIND or layout.get("schemaVersion") != layout_probe.REPORT_SCHEMA_VERSION:
        raise RuntimeError("unexpected upstream endpoint layout contract")
    if layout.get("status") != "pass" or layout.get("decisionStatus") != "diagnostic-only":
        raise RuntimeError("endpoint layout must pass and remain diagnostic-only")
    identity = layout.get("pinnedSourceExternalDataIdentity")
    if not isinstance(identity, dict):
        raise RuntimeError("pinned source external-data identity missing")
    if identity.get("bytes") != preferred_webgpu.PINNED_EXTERNAL_DATA_BYTES or identity.get("sha256") != preferred_webgpu.PINNED_EXTERNAL_DATA_SHA256:
        raise RuntimeError("pinned source external-data identity drifted")

    source_fd, source_identity, source_hash = preferred_webgpu._open_pinned_source(source_external_data)
    try:
        candidates = layout.get("candidates")
        if not isinstance(candidates, list):
            raise RuntimeError("layout candidates missing")
        matches = [c for c in candidates if isinstance(c, dict) and c.get("physicalArtifactCount") == PHYSICAL_ARTIFACT_COUNT]
        if len(matches) != 1:
            raise RuntimeError("expected exactly one pinned 5-way layout candidate")
        candidate = matches[0]
        tiles = candidate.get("executionTiles")
        physical = candidate.get("physicalArtifacts")
        if not isinstance(tiles, list) or len(tiles) != EXECUTION_TILE_COUNT or not isinstance(physical, list) or len(physical) != PHYSICAL_ARTIFACT_COUNT:
            raise RuntimeError("pinned 5-way candidate geometry missing")
        tile = tiles[SELECTED_TILE_INDEX]
        if not isinstance(tile, dict) or tile.get("tileIndex") != SELECTED_TILE_INDEX or tile.get("physicalArtifactCount") != 2:
            raise RuntimeError("selected tile is no longer the pinned two-artifact crossing tile")
        slices = tile.get("physicalSlices")
        if not isinstance(slices, list) or len(slices) != 2 or not all(isinstance(sl, dict) for sl in slices):
            raise RuntimeError("selected tile must expose exactly two physical slices")

        row_bytes = layout.get("rowBytes")
        if not isinstance(row_bytes, int) or isinstance(row_bytes, bool) or row_bytes <= 0 or row_bytes % FLOAT32_BYTES:
            raise RuntimeError("invalid pinned rowBytes")
        hidden_size = row_bytes // FLOAT32_BYTES
        tile_rows = tile.get("rowCount")
        if not isinstance(tile_rows, int) or isinstance(tile_rows, bool) or tile_rows <= 0:
            raise RuntimeError("invalid selected tile rowCount")

        required_indices = sorted({int(sl["physicalArtifactIndex"]) for sl in slices})
        if required_indices != [0, 1]:
            raise RuntimeError(f"selected tile physical artifact set drifted: {required_indices}")

        if output_dir.exists() or output_dir.is_symlink():
            output_snap = output_dir.lstat()
            if stat.S_ISLNK(output_snap.st_mode) or not stat.S_ISDIR(output_snap.st_mode):
                raise RuntimeError("output directory must be a real directory, not a symlink")
            if any(output_dir.iterdir()):
                raise RuntimeError("output directory must be empty")
        else:
            output_dir.mkdir(parents=True)

        physical_by_index = {artifact.get("index"): artifact for artifact in physical if isinstance(artifact, dict)}
        manifest_artifacts: list[dict[str, object]] = []
        for artifact_index in required_indices:
            artifact = physical_by_index.get(artifact_index)
            if not isinstance(artifact, dict):
                raise RuntimeError(f"missing physical artifact {artifact_index}")
            source_offset = artifact.get("sourceOffsetBytes")
            source_end = artifact.get("sourceEndOffsetBytesExclusive")
            length = artifact.get("byteLength")
            if not all(isinstance(value, int) and not isinstance(value, bool) for value in (source_offset, source_end, length)):
                raise RuntimeError("invalid physical artifact geometry")
            if source_offset < 0 or length <= 0 or source_end - source_offset != length:
                raise RuntimeError("physical artifact source range mismatch")
            file_name = f"payload-{artifact_index:04d}.bin"
            path = output_dir / file_name
            sha256 = _copy_source_range(source_fd, source_offset=source_offset, length=length, destination=path)
            manifest_artifacts.append({
                "index": artifact_index,
                "file": file_name,
                "bytes": length,
                "sha256": sha256,
                "sourceOffsetBytes": source_offset,
                "sourceEndOffsetBytesExclusive": source_end,
            })

        manifest_slices: list[dict[str, object]] = []
        for sl in slices:
            artifact_index = sl["physicalArtifactIndex"]
            artifact = physical_by_index[artifact_index]
            offset = sl["artifactByteOffset"]
            length = sl["byteLength"]
            if offset < 0 or length <= 0 or offset + length > artifact["byteLength"]:
                raise RuntimeError("selected slice exceeds its physical artifact")
            manifest_slices.append({
                "physicalArtifactIndex": artifact_index,
                "startRow": sl["startRow"],
                "endRowExclusive": sl["endRowExclusive"],
                "rowCount": sl["rowCount"],
                "artifactByteOffset": offset,
                "byteLength": length,
            })

        graphs: dict[str, dict[str, object]] = {}
        for mode in ("embedding", "logits"):
            file_name = f"tile-{SELECTED_TILE_INDEX}-{mode}.onnx"
            graph_path = output_dir / file_name
            onnx.save(build_probe_model(mode=mode, hidden_size=hidden_size, tile_rows=tile_rows, slices=manifest_slices), graph_path)
            onnx.checker.check_model(str(graph_path), full_check=True)
            graphs[mode] = {
                "file": file_name,
                "bytes": graph_path.stat().st_size,
                "sha256": preferred_webgpu._sha256_file(graph_path),
            }

        manifest = {
            "schemaVersion": REPORT_SCHEMA_VERSION,
            "kind": REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": layout.get("sourceGraphSha256"),
            "sourceExternalData": {
                "bytes": preferred_webgpu.PINNED_EXTERNAL_DATA_BYTES,
                "sha256": source_hash,
            },
            "physicalArtifactCount": PHYSICAL_ARTIFACT_COUNT,
            "executionTileCount": EXECUTION_TILE_COUNT,
            "selectedTileIndex": SELECTED_TILE_INDEX,
            "hiddenSize": hidden_size,
            "onnxruntimeWebVersion": ORT_WEB_VERSION,
            "physicalArtifacts": manifest_artifacts,
            "tile": {
                "tileIndex": SELECTED_TILE_INDEX,
                "startRow": tile.get("startRow"),
                "endRowExclusive": tile.get("endRowExclusive"),
                "rowCount": tile_rows,
                "byteLength": tile.get("byteLength"),
                "physicalSlices": manifest_slices,
                "graphs": graphs,
            },
            "conclusion": (
                "Prepared a diagnostic-only ORT Web/WebGPU probe for one 5-way boundary-crossing execution tile. "
                "Two whole verified physical payloads are supplied independently and concatenated inside each "
                "temporary ONNX graph. Preparation does not select the 5-way layout or prove browser execution."
            ),
        }
        (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        return manifest
    finally:
        try:
            preferred_webgpu._assert_source_path_identity(source_external_data, source_identity)
        finally:
            os.close(source_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path)
    parser.add_argument("source_external_data", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    report = prepare(args.source_model.absolute(), args.source_external_data.absolute(), args.output_dir.absolute())
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
