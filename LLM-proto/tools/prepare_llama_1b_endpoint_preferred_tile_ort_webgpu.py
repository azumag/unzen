#!/usr/bin/env python3
"""Prepare a diagnostic ORT Web/WebGPU range-binding probe for issue #223.

The probe intentionally exercises only preferred 4-way physical artifact 0 and
8-way execution tiles 0 and 1. Tile 0 starts at byte offset 0; tile 1 starts at
a non-zero byte offset inside the same 250.5 MiB physical payload. This keeps
the experiment below the existing preferred browser-artifact ceiling while
answering the narrow S0 question of whether ORT Web/WebGPU honors external-data
range offsets inside a verified physical payload.

This tool does not select the 4-way layout, adopt 8-way execution, or define a
manifest/cache/runtime/dispatcher contract.
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

import probe_llama_1b_endpoint_layout_candidates as layout_probe


REPORT_KIND = "unzen-pinned-llama-1b-endpoint-preferred-tile-ort-webgpu-preparation"
REPORT_SCHEMA_VERSION = "1.0.0"
PINNED_EXTERNAL_DATA_BYTES = 1_692_672_000
PINNED_EXTERNAL_DATA_SHA256 = "07cc629ef2cb7fdb18615ce2e4f3774f763e6fc840207d772a8b511eead36647"
PINNED_PAYLOAD0_BYTES = 262_668_288
PINNED_PAYLOAD0_SHA256 = "b783704059e886b1e5438d23c3f9911b0d947c86125501c9071e5bb8f7cebdce"
PHYSICAL_ARTIFACT_COUNT = 4
EXECUTION_TILE_COUNT = 8
SELECTED_TILE_INDICES = (0, 1)
FLOAT32_BYTES = 4
ORT_WEB_VERSION = "1.22.0"


def _sha256_file(path: Path, *, byte_limit: int | None = None) -> str:
    digest = hashlib.sha256()
    remaining = byte_limit
    with path.open("rb") as handle:
        while remaining is None or remaining > 0:
            size = 8 * 1024 * 1024 if remaining is None else min(8 * 1024 * 1024, remaining)
            chunk = handle.read(size)
            if not chunk:
                if remaining not in (None, 0):
                    raise RuntimeError(f"unexpected EOF while hashing {path}")
                break
            digest.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
    return digest.hexdigest()


def _external_weight_tensor(*, rows: int, hidden_size: int, offset: int, length: int) -> TensorProto:
    expected = rows * hidden_size * FLOAT32_BYTES
    if length != expected:
        raise RuntimeError(f"tile weight length mismatch: expected {expected}, got {length}")
    tensor = TensorProto()
    tensor.name = "tile_weight"
    tensor.data_type = TensorProto.FLOAT
    tensor.dims.extend([rows, hidden_size])
    tensor.data_location = TensorProto.EXTERNAL
    for key, value in (("location", "payload-0000.bin"), ("offset", str(offset)), ("length", str(length))):
        item = tensor.external_data.add()
        item.key = key
        item.value = value
    return tensor


def build_probe_model(*, mode: str, rows: int, hidden_size: int, offset: int, length: int) -> onnx.ModelProto:
    initializer = _external_weight_tensor(rows=rows, hidden_size=hidden_size, offset=offset, length=length)
    if mode == "embedding":
        model_input = helper.make_tensor_value_info("local_ids", TensorProto.INT64, [None])
        model_output = helper.make_tensor_value_info("embedding", TensorProto.FLOAT, [None, hidden_size])
        nodes = [helper.make_node("Gather", ["tile_weight", "local_ids"], ["embedding"], axis=0)]
    elif mode == "logits":
        model_input = helper.make_tensor_value_info("hidden", TensorProto.FLOAT, [1, hidden_size])
        model_output = helper.make_tensor_value_info("tile_logits", TensorProto.FLOAT, [1, rows])
        nodes = [
            helper.make_node("Transpose", ["tile_weight"], ["tile_weight_transposed"], perm=[1, 0]),
            helper.make_node("MatMul", ["hidden", "tile_weight_transposed"], ["tile_logits"]),
        ]
    else:
        raise RuntimeError(f"unsupported mode: {mode}")
    graph = helper.make_graph(nodes, f"unzen-endpoint-webgpu-{mode}", [model_input], [model_output], [initializer])
    return helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 21)],
        ir_version=10,
        producer_name="unzen-diagnostic",
    )


def _identity(snapshot: os.stat_result) -> tuple[int, int, int, int, int]:
    return (snapshot.st_dev, snapshot.st_ino, snapshot.st_size, snapshot.st_mtime_ns, snapshot.st_ctime_ns)


def _open_pinned_source(path: Path) -> tuple[int, tuple[int, int, int, int, int], str]:
    snap = path.lstat()
    if stat.S_ISLNK(snap.st_mode) or not stat.S_ISREG(snap.st_mode):
        raise RuntimeError("pinned source external data must be a regular non-symlink file")
    if snap.st_size != PINNED_EXTERNAL_DATA_BYTES:
        raise RuntimeError(
            f"pinned source external-data size mismatch: expected {PINNED_EXTERNAL_DATA_BYTES}, got {snap.st_size}"
        )
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        opened = os.fstat(fd)
        if _identity(opened) != _identity(snap):
            raise RuntimeError("pinned source changed while being opened")
        digest = hashlib.sha256()
        offset = 0
        while offset < opened.st_size:
            chunk = os.pread(fd, min(8 * 1024 * 1024, opened.st_size - offset), offset)
            if not chunk:
                raise RuntimeError("unexpected EOF while hashing pinned source")
            digest.update(chunk)
            offset += len(chunk)
        after = os.fstat(fd)
        identity = _identity(opened)
        if _identity(after) != identity:
            raise RuntimeError("pinned source changed while hashing")
        actual = digest.hexdigest()
        if actual != PINNED_EXTERNAL_DATA_SHA256:
            raise RuntimeError(
                f"source external-data SHA-256 mismatch: expected {PINNED_EXTERNAL_DATA_SHA256}, got {actual}"
            )
        return fd, identity, actual
    except Exception:
        os.close(fd)
        raise


def _assert_source_path_identity(path: Path, identity: tuple[int, int, int, int, int]) -> None:
    try:
        current = path.lstat()
    except FileNotFoundError as exc:
        raise RuntimeError("pinned source path disappeared during preparation") from exc
    if _identity(current) != identity:
        raise RuntimeError("pinned source path identity changed during preparation")


def _copy_payload0(source_fd: int, destination: Path) -> str:
    digest = hashlib.sha256()
    with destination.open("xb") as dst:
        offset = 0
        while offset < PINNED_PAYLOAD0_BYTES:
            chunk = os.pread(source_fd, min(8 * 1024 * 1024, PINNED_PAYLOAD0_BYTES - offset), offset)
            if not chunk:
                raise RuntimeError("unexpected EOF while materializing preferred payload 0")
            dst.write(chunk)
            digest.update(chunk)
            offset += len(chunk)
    actual = digest.hexdigest()
    if actual != PINNED_PAYLOAD0_SHA256:
        destination.unlink(missing_ok=True)
        raise RuntimeError(f"payload-0000 SHA-256 mismatch: expected {PINNED_PAYLOAD0_SHA256}, got {actual}")
    return actual


def prepare(source_model: Path, source_external_data: Path, output_dir: Path) -> dict[str, object]:
    layout = layout_probe.build_report(source_model)
    if layout.get("kind") != layout_probe.REPORT_KIND or layout.get("schemaVersion") != layout_probe.REPORT_SCHEMA_VERSION:
        raise RuntimeError("unexpected upstream endpoint layout contract")
    if layout.get("status") != "pass" or layout.get("decisionStatus") != "diagnostic-only":
        raise RuntimeError("endpoint layout must pass and remain diagnostic-only")
    identity = layout.get("pinnedSourceExternalDataIdentity")
    if not isinstance(identity, dict) or identity.get("bytes") != PINNED_EXTERNAL_DATA_BYTES or identity.get("sha256") != PINNED_EXTERNAL_DATA_SHA256:
        raise RuntimeError("pinned source external-data identity drifted")

    source_fd, source_identity, source_hash = _open_pinned_source(source_external_data)
    try:
        candidates = layout.get("candidates")
        if not isinstance(candidates, list):
            raise RuntimeError("layout candidates missing")
        matches = [c for c in candidates if isinstance(c, dict) and c.get("physicalArtifactCount") == PHYSICAL_ARTIFACT_COUNT]
        if len(matches) != 1:
            raise RuntimeError("expected exactly one pinned 4-way layout candidate")
        candidate = matches[0]
        tiles = candidate.get("executionTiles")
        physical = candidate.get("physicalArtifacts")
        if not isinstance(tiles, list) or len(tiles) != EXECUTION_TILE_COUNT or not isinstance(physical, list):
            raise RuntimeError("pinned 4-way candidate geometry missing")
        artifact0 = next((a for a in physical if isinstance(a, dict) and a.get("index") == 0), None)
        if not isinstance(artifact0, dict) or artifact0.get("byteLength") != PINNED_PAYLOAD0_BYTES:
            raise RuntimeError("preferred physical artifact 0 contract drifted")

        if output_dir.exists() or output_dir.is_symlink():
            output_snap = output_dir.lstat()
            if stat.S_ISLNK(output_snap.st_mode) or not stat.S_ISDIR(output_snap.st_mode):
                raise RuntimeError("output directory must be a real directory, not a symlink")
            if any(output_dir.iterdir()):
                raise RuntimeError("output directory must be empty")
        else:
            output_dir.mkdir(parents=True)
        payload_path = output_dir / "payload-0000.bin"
        payload_sha = _copy_payload0(source_fd, payload_path)

        hidden_size = layout.get("rowBytes")
        if not isinstance(hidden_size, int) or isinstance(hidden_size, bool) or hidden_size % FLOAT32_BYTES:
            raise RuntimeError("invalid rowBytes")
        hidden_size //= FLOAT32_BYTES

        manifest_tiles: list[dict[str, object]] = []
        for tile_index in SELECTED_TILE_INDICES:
            tile = tiles[tile_index]
            if not isinstance(tile, dict) or tile.get("tileIndex") != tile_index:
                raise RuntimeError(f"tile contract drift at {tile_index}")
            slices = tile.get("physicalSlices")
            if not isinstance(slices, list) or len(slices) != 1 or not isinstance(slices[0], dict):
                raise RuntimeError(f"tile {tile_index} must map to one physical slice")
            sl = slices[0]
            if sl.get("physicalArtifactIndex") != 0:
                raise RuntimeError(f"selected tile {tile_index} no longer maps to physical artifact 0")
            rows = tile.get("rowCount")
            offset = sl.get("artifactByteOffset")
            length = sl.get("byteLength")
            if not all(isinstance(v, int) and not isinstance(v, bool) for v in (rows, offset, length)):
                raise RuntimeError(f"invalid tile {tile_index} geometry")
            if offset < 0 or length <= 0 or offset + length > PINNED_PAYLOAD0_BYTES:
                raise RuntimeError(f"tile {tile_index} exceeds physical artifact 0")

            graphs: dict[str, dict[str, object]] = {}
            for mode in ("embedding", "logits"):
                file_name = f"tile-{tile_index}-{mode}.onnx"
                graph_path = output_dir / file_name
                onnx.save(build_probe_model(mode=mode, rows=rows, hidden_size=hidden_size, offset=offset, length=length), graph_path)
                onnx.checker.check_model(str(graph_path), full_check=True)
                graphs[mode] = {
                    "file": file_name,
                    "bytes": graph_path.stat().st_size,
                    "sha256": _sha256_file(graph_path),
                }
            manifest_tiles.append(
                {
                    "tileIndex": tile_index,
                    "startRow": tile.get("startRow"),
                    "endRowExclusive": tile.get("endRowExclusive"),
                    "rowCount": rows,
                    "artifactByteOffset": offset,
                    "byteLength": length,
                    "graphs": graphs,
                }
            )

        manifest = {
            "schemaVersion": REPORT_SCHEMA_VERSION,
            "kind": REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": layout.get("sourceGraphSha256"),
            "sourceExternalData": {
                "bytes": PINNED_EXTERNAL_DATA_BYTES,
                "sha256": source_hash,
            },
            "physicalArtifact": {
                "index": 0,
                "file": payload_path.name,
                "bytes": PINNED_PAYLOAD0_BYTES,
                "sha256": payload_sha,
            },
            "physicalArtifactCount": PHYSICAL_ARTIFACT_COUNT,
            "executionTileCount": EXECUTION_TILE_COUNT,
            "selectedTileIndices": list(SELECTED_TILE_INDICES),
            "hiddenSize": hidden_size,
            "onnxruntimeWebVersion": ORT_WEB_VERSION,
            "tiles": manifest_tiles,
            "conclusion": (
                "Prepared a diagnostic-only ORT Web/WebGPU probe for preferred 4-way physical artifact 0. "
                "Tiles 0 and 1 deliberately cover zero and non-zero external-data offsets; preparation does "
                "not select an endpoint architecture or prove browser execution by itself."
            ),
        }
        (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        return manifest
    finally:
        try:
            _assert_source_path_identity(source_external_data, source_identity)
        finally:
            os.close(source_fd)


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
