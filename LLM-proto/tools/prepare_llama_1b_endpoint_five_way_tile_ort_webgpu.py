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
    if not isinstance(source_offset, int) or isinstance(source_offset, bool) or source_offset < 0:
        raise ValueError("source_offset must be a non-negative integer")
    if not isinstance(length, int) or isinstance(length, bool) or length <= 0:
        raise ValueError("length must be a positive integer")
    digest = hashlib.sha256()
    cursor = 0
    destination_created = False
    try:
        with destination.open("xb") as dst:
            destination_created = True
            while cursor < length:
                chunk = os.pread(source_fd, min(8 * 1024 * 1024, length - cursor), source_offset + cursor)
                if not chunk:
                    raise RuntimeError("unexpected EOF while materializing 5-way physical payload")
                dst.write(chunk)
                digest.update(chunk)
                cursor += len(chunk)
    except Exception:
        if destination_created:
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                pass
        raise
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


def _strict_int(value: object, *, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise RuntimeError(f"{label} must be a non-bool integer")
    return value


def _preflight_five_way_tile_geometry(
    layout: dict[str, object],
) -> tuple[int, dict[str, object], list[dict[str, int]]]:
    """Validate and snapshot the selected five-way crossing tile before source I/O."""

    row_bytes = _strict_int(layout.get("rowBytes"), label="rowBytes")
    if row_bytes <= 0 or row_bytes % FLOAT32_BYTES:
        raise RuntimeError("invalid pinned rowBytes")
    hidden_size = row_bytes // FLOAT32_BYTES

    candidates = layout.get("candidates")
    if not isinstance(candidates, list):
        raise RuntimeError("layout candidates missing")
    matches = [
        candidate
        for candidate in candidates
        if isinstance(candidate, dict)
        and isinstance(candidate.get("physicalArtifactCount"), int)
        and not isinstance(candidate.get("physicalArtifactCount"), bool)
        and candidate.get("physicalArtifactCount") == PHYSICAL_ARTIFACT_COUNT
    ]
    if len(matches) != 1:
        raise RuntimeError("expected exactly one pinned 5-way layout candidate")
    candidate = matches[0]

    tiles = candidate.get("executionTiles")
    physical = candidate.get("physicalArtifacts")
    if (
        not isinstance(tiles, list)
        or len(tiles) != EXECUTION_TILE_COUNT
        or not isinstance(physical, list)
        or len(physical) != PHYSICAL_ARTIFACT_COUNT
    ):
        raise RuntimeError("pinned 5-way candidate geometry missing")

    physical_by_index: dict[int, dict[str, int]] = {}
    for artifact in physical:
        if not isinstance(artifact, dict):
            raise RuntimeError("physical artifact descriptor must be an object")
        artifact_index = _strict_int(artifact.get("index"), label="physical artifact index")
        if artifact_index < 0 or artifact_index >= PHYSICAL_ARTIFACT_COUNT:
            raise RuntimeError(f"physical artifact index out of range: {artifact_index}")
        if artifact_index in physical_by_index:
            raise RuntimeError(f"duplicate physical artifact index: {artifact_index}")
        byte_length = _strict_int(
            artifact.get("byteLength"),
            label=f"physical artifact {artifact_index} byteLength",
        )
        source_offset = _strict_int(
            artifact.get("sourceOffsetBytes"),
            label=f"physical artifact {artifact_index} sourceOffsetBytes",
        )
        source_end = _strict_int(
            artifact.get("sourceEndOffsetBytesExclusive"),
            label=f"physical artifact {artifact_index} sourceEndOffsetBytesExclusive",
        )
        if source_offset < 0 or byte_length <= 0 or source_end <= source_offset:
            raise RuntimeError(f"invalid physical artifact {artifact_index} source range")
        if source_end - source_offset != byte_length:
            raise RuntimeError(f"physical artifact {artifact_index} source range mismatch")
        if source_end > preferred_webgpu.PINNED_EXTERNAL_DATA_BYTES:
            raise RuntimeError(f"physical artifact {artifact_index} exceeds pinned source payload")
        physical_by_index[artifact_index] = {
            "index": artifact_index,
            "byteLength": byte_length,
            "sourceOffsetBytes": source_offset,
            "sourceEndOffsetBytesExclusive": source_end,
        }
    if set(physical_by_index) != set(range(PHYSICAL_ARTIFACT_COUNT)):
        raise RuntimeError("pinned 5-way physical artifact indices must be canonical")

    tile = tiles[SELECTED_TILE_INDEX]
    if not isinstance(tile, dict):
        raise RuntimeError("selected tile must be an object")
    tile_index = _strict_int(tile.get("tileIndex"), label="selected tileIndex")
    if tile_index != SELECTED_TILE_INDEX:
        raise RuntimeError("selected tile index drifted")
    physical_artifact_count = _strict_int(
        tile.get("physicalArtifactCount"),
        label="selected tile physicalArtifactCount",
    )
    if physical_artifact_count != 2:
        raise RuntimeError("selected tile is no longer the pinned two-artifact crossing tile")

    tile_start = _strict_int(tile.get("startRow"), label="selected tile startRow")
    tile_end = _strict_int(tile.get("endRowExclusive"), label="selected tile endRowExclusive")
    tile_rows = _strict_int(tile.get("rowCount"), label="selected tile rowCount")
    tile_bytes = _strict_int(tile.get("byteLength"), label="selected tile byteLength")
    if tile_start < 0 or tile_end <= tile_start or tile_rows != tile_end - tile_start:
        raise RuntimeError("selected tile row geometry mismatch")
    if tile_bytes != tile_rows * row_bytes:
        raise RuntimeError("selected tile byte geometry mismatch")

    slices = tile.get("physicalSlices")
    if not isinstance(slices, list) or len(slices) != 2 or not all(isinstance(sl, dict) for sl in slices):
        raise RuntimeError("selected tile must expose exactly two physical slices")

    snapshot_slices: list[dict[str, int]] = []
    for slice_index, sl in enumerate(slices):
        artifact_index = _strict_int(
            sl.get("physicalArtifactIndex"),
            label=f"selected slice {slice_index} physicalArtifactIndex",
        )
        if artifact_index not in (0, 1):
            raise RuntimeError("selected tile physical artifact set drifted")
        artifact = physical_by_index[artifact_index]
        start_row = _strict_int(sl.get("startRow"), label=f"selected slice {slice_index} startRow")
        end_row = _strict_int(
            sl.get("endRowExclusive"),
            label=f"selected slice {slice_index} endRowExclusive",
        )
        row_count = _strict_int(sl.get("rowCount"), label=f"selected slice {slice_index} rowCount")
        offset = _strict_int(
            sl.get("artifactByteOffset"),
            label=f"selected slice {slice_index} artifactByteOffset",
        )
        byte_length = _strict_int(
            sl.get("byteLength"),
            label=f"selected slice {slice_index} byteLength",
        )
        if start_row < 0 or end_row <= start_row or row_count != end_row - start_row:
            raise RuntimeError(f"selected slice {slice_index} row geometry mismatch")
        if byte_length != row_count * row_bytes:
            raise RuntimeError(f"selected slice {slice_index} byte geometry mismatch")
        if offset < 0 or byte_length <= 0 or offset + byte_length > artifact["byteLength"]:
            raise RuntimeError(f"selected slice {slice_index} exceeds physical artifact {artifact_index}")
        snapshot_slices.append(
            {
                "physicalArtifactIndex": artifact_index,
                "startRow": start_row,
                "endRowExclusive": end_row,
                "rowCount": row_count,
                "artifactByteOffset": offset,
                "byteLength": byte_length,
            }
        )

    first, second = snapshot_slices
    if [first["physicalArtifactIndex"], second["physicalArtifactIndex"]] != [0, 1]:
        raise RuntimeError("selected tile slices must use physical artifacts 0 then 1")
    if first["startRow"] != tile_start or first["endRowExclusive"] != second["startRow"] or second["endRowExclusive"] != tile_end:
        raise RuntimeError("selected tile slices must be row-contiguous and cover the tile exactly")
    if first["rowCount"] + second["rowCount"] != tile_rows:
        raise RuntimeError("selected tile slice rows do not reconstruct tile rows")
    if first["byteLength"] + second["byteLength"] != tile_bytes:
        raise RuntimeError("selected tile slice bytes do not reconstruct tile bytes")

    tile_snapshot: dict[str, object] = {
        "tileIndex": tile_index,
        "startRow": tile_start,
        "endRowExclusive": tile_end,
        "rowCount": tile_rows,
        "byteLength": tile_bytes,
        "physicalSlices": [dict(sl) for sl in snapshot_slices],
    }
    required_physical = [dict(physical_by_index[index]) for index in (0, 1)]
    return hidden_size, tile_snapshot, required_physical


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

    hidden_size, tile_snapshot, required_physical = _preflight_five_way_tile_geometry(layout)
    tile_rows = tile_snapshot["rowCount"]
    if not isinstance(tile_rows, int):
        raise AssertionError("preflight must snapshot an integer rowCount")
    manifest_slices = tile_snapshot["physicalSlices"]
    if not isinstance(manifest_slices, list):
        raise AssertionError("preflight must snapshot physical slices")

    source_fd, source_identity, source_hash = preferred_webgpu._open_pinned_source(source_external_data)
    try:
        if output_dir.exists() or output_dir.is_symlink():
            output_snap = output_dir.lstat()
            if stat.S_ISLNK(output_snap.st_mode) or not stat.S_ISDIR(output_snap.st_mode):
                raise RuntimeError("output directory must be a real directory, not a symlink")
            if any(output_dir.iterdir()):
                raise RuntimeError("output directory must be empty")
        else:
            output_dir.mkdir(parents=True)

        manifest_artifacts: list[dict[str, object]] = []
        for artifact in required_physical:
            artifact_index = artifact["index"]
            source_offset = artifact["sourceOffsetBytes"]
            source_end = artifact["sourceEndOffsetBytesExclusive"]
            length = artifact["byteLength"]
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

        graphs: dict[str, dict[str, object]] = {}
        for mode in ("embedding", "logits"):
            file_name = f"tile-{SELECTED_TILE_INDEX}-{mode}.onnx"
            graph_path = output_dir / file_name
            onnx.save(build_probe_model(mode=mode, hidden_size=hidden_size, tile_rows=tile_rows, slices=manifest_slices), graph_path)
            graph_bytes, graph_sha256 = preferred_webgpu._measure_regular_file(
                graph_path, check_onnx=True
            )
            graphs[mode] = {
                "file": file_name,
                "bytes": graph_bytes,
                "sha256": graph_sha256,
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
                "startRow": tile_snapshot["startRow"],
                "endRowExclusive": tile_snapshot["endRowExclusive"],
                "rowCount": tile_rows,
                "byteLength": tile_snapshot["byteLength"],
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
