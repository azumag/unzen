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
import tempfile

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


def _identity(snapshot: os.stat_result) -> tuple[int, int, int, int, int]:
    return (snapshot.st_dev, snapshot.st_ino, snapshot.st_size, snapshot.st_mtime_ns, snapshot.st_ctime_ns)


def _measure_regular_file(
    path: Path,
    *,
    byte_limit: int | None = None,
    check_onnx: bool = False,
) -> tuple[int, str]:
    """Measure one stable non-symlink regular-file descriptor snapshot.

    When ``check_onnx`` is true, the ONNX checker validates an exclusive
    same-directory copy made from the exact bytes hashed by this snapshot. This
    keeps relative external-data paths meaningful while preventing checker
    validation and manifest metadata from referring to different graph bytes.
    """

    if byte_limit is not None and (
        not isinstance(byte_limit, int) or isinstance(byte_limit, bool) or byte_limit < 0
    ):
        raise ValueError("byte_limit must be None or a non-negative integer")
    if not isinstance(check_onnx, bool):
        raise ValueError("check_onnx must be a boolean")
    if check_onnx and byte_limit is not None:
        raise ValueError("check_onnx requires a full-file snapshot")
    path = path.expanduser().absolute()
    try:
        before = os.lstat(path)
    except OSError as error:
        raise RuntimeError(f"file is not readable: {path}: {error}") from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise RuntimeError(f"file must be a regular non-symlink file: {path}")

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except OSError as error:
        raise RuntimeError(f"file could not be opened safely: {path}: {error}") from error

    digest = hashlib.sha256()
    checker_chunks: list[bytes] | None = [] if check_onnx else None
    observed = 0
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise RuntimeError(f"file must remain a regular file: {path}")
        if _identity(opened) != _identity(before):
            raise RuntimeError(f"file changed between path check and open: {path}")
        target_bytes = opened.st_size if byte_limit is None else byte_limit
        while observed < target_bytes:
            block = os.read(fd, min(8 * 1024 * 1024, target_bytes - observed))
            if not block:
                raise RuntimeError(f"unexpected EOF while hashing {path}")
            digest.update(block)
            if checker_chunks is not None:
                checker_chunks.append(block)
            observed += len(block)
        if byte_limit is None:
            extra = os.read(fd, 1)
            if extra:
                raise RuntimeError(f"file grew while being hashed: {path}")
        after_fd = os.fstat(fd)
        if _identity(after_fd) != _identity(opened):
            raise RuntimeError(f"file changed while being hashed: {path}")
    finally:
        os.close(fd)

    try:
        after_path = os.lstat(path)
    except OSError as error:
        raise RuntimeError(f"file path disappeared after hashing: {path}: {error}") from error
    if stat.S_ISLNK(after_path.st_mode) or _identity(after_path) != _identity(opened):
        raise RuntimeError(f"file path changed while being hashed: {path}")

    if checker_chunks is not None:
        descriptor, checker_name = tempfile.mkstemp(
            dir=path.parent,
            prefix=f".{path.stem}-checker-",
            suffix=".onnx",
        )
        checker_path = Path(checker_name)
        try:
            checker_stream = os.fdopen(descriptor, "wb")
            descriptor = -1
            with checker_stream:
                for block in checker_chunks:
                    checker_stream.write(block)
            onnx.checker.check_model(str(checker_path), full_check=True)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            checker_path.unlink(missing_ok=True)

    return observed, digest.hexdigest()


def _sha256_file(path: Path, *, byte_limit: int | None = None) -> str:
    """Compatibility wrapper returning the descriptor-pinned SHA-256 digest."""

    _, digest = _measure_regular_file(path, byte_limit=byte_limit)
    return digest


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


def _open_pinned_source(path: Path) -> tuple[int, tuple[int, int, int, int, int], str]:
    snap = path.lstat()
    if stat.S_ISLNK(snap.st_mode) or not stat.S_ISREG(snap.st_mode):
        raise RuntimeError("pinned source external data must be a regular non-symlink file")
    if snap.st_size != PINNED_EXTERNAL_DATA_BYTES:
        raise RuntimeError(
            f"pinned source external-data size mismatch: expected {PINNED_EXTERNAL_DATA_BYTES}, got {snap.st_size}"
        )
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except OSError as error:
        raise RuntimeError(f"pinned source external data could not be opened safely: {path}: {error}") from error
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise RuntimeError("pinned source external data must remain a regular file")
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


def _strict_int(value: object, *, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise RuntimeError(f"{label} must be a non-bool integer")
    return value


def _preflight_preferred_tile_geometry(layout: dict[str, object]) -> tuple[int, list[dict[str, int]]]:
    """Validate and snapshot the narrow preferred tile geometry before source I/O."""

    row_bytes = _strict_int(layout.get("rowBytes"), label="rowBytes")
    if row_bytes <= 0 or row_bytes % FLOAT32_BYTES:
        raise RuntimeError("invalid rowBytes")
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
        raise RuntimeError("expected exactly one pinned 4-way layout candidate")
    candidate = matches[0]

    tiles = candidate.get("executionTiles")
    physical = candidate.get("physicalArtifacts")
    if (
        not isinstance(tiles, list)
        or len(tiles) != EXECUTION_TILE_COUNT
        or not isinstance(physical, list)
        or len(physical) != PHYSICAL_ARTIFACT_COUNT
    ):
        raise RuntimeError("pinned 4-way candidate geometry missing")

    artifact0_matches = [
        artifact
        for artifact in physical
        if isinstance(artifact, dict)
        and isinstance(artifact.get("index"), int)
        and not isinstance(artifact.get("index"), bool)
        and artifact.get("index") == 0
    ]
    if len(artifact0_matches) != 1:
        raise RuntimeError("expected exactly one preferred physical artifact 0 descriptor")
    artifact0 = artifact0_matches[0]
    artifact0_bytes = _strict_int(artifact0.get("byteLength"), label="physical artifact 0 byteLength")
    if artifact0_bytes != PINNED_PAYLOAD0_BYTES:
        raise RuntimeError("preferred physical artifact 0 contract drifted")

    selected: list[dict[str, int]] = []
    for tile_index in SELECTED_TILE_INDICES:
        tile = tiles[tile_index]
        if not isinstance(tile, dict):
            raise RuntimeError(f"tile contract drift at {tile_index}")
        actual_index = _strict_int(tile.get("tileIndex"), label=f"tile {tile_index} tileIndex")
        if actual_index != tile_index:
            raise RuntimeError(f"tile contract drift at {tile_index}")

        start_row = _strict_int(tile.get("startRow"), label=f"tile {tile_index} startRow")
        end_row = _strict_int(tile.get("endRowExclusive"), label=f"tile {tile_index} endRowExclusive")
        row_count = _strict_int(tile.get("rowCount"), label=f"tile {tile_index} rowCount")
        tile_byte_length = _strict_int(tile.get("byteLength"), label=f"tile {tile_index} byteLength")
        if start_row < 0 or end_row <= start_row or row_count != end_row - start_row:
            raise RuntimeError(f"tile {tile_index} row geometry mismatch")
        if tile_byte_length != row_count * row_bytes:
            raise RuntimeError(f"tile {tile_index} byte geometry mismatch")

        slices = tile.get("physicalSlices")
        if not isinstance(slices, list) or len(slices) != 1 or not isinstance(slices[0], dict):
            raise RuntimeError(f"tile {tile_index} must map to one physical slice")
        sl = slices[0]
        artifact_index = _strict_int(
            sl.get("physicalArtifactIndex"),
            label=f"tile {tile_index} physicalArtifactIndex",
        )
        if artifact_index != 0:
            raise RuntimeError(f"selected tile {tile_index} no longer maps to physical artifact 0")

        slice_start = _strict_int(sl.get("startRow"), label=f"tile {tile_index} slice startRow")
        slice_end = _strict_int(
            sl.get("endRowExclusive"),
            label=f"tile {tile_index} slice endRowExclusive",
        )
        slice_rows = _strict_int(sl.get("rowCount"), label=f"tile {tile_index} slice rowCount")
        offset = _strict_int(
            sl.get("artifactByteOffset"),
            label=f"tile {tile_index} artifactByteOffset",
        )
        length = _strict_int(sl.get("byteLength"), label=f"tile {tile_index} slice byteLength")
        if (slice_start, slice_end, slice_rows) != (start_row, end_row, row_count):
            raise RuntimeError(f"tile {tile_index} slice row geometry mismatch")
        if length != tile_byte_length:
            raise RuntimeError(f"tile {tile_index} slice byte geometry mismatch")
        if offset < 0 or length <= 0 or offset + length > artifact0_bytes:
            raise RuntimeError(f"tile {tile_index} exceeds physical artifact 0")

        selected.append(
            {
                "tileIndex": tile_index,
                "startRow": start_row,
                "endRowExclusive": end_row,
                "rowCount": row_count,
                "artifactByteOffset": offset,
                "byteLength": length,
            }
        )

    first, second = selected
    if first["startRow"] != 0 or first["artifactByteOffset"] != 0:
        raise RuntimeError("selected tile 0 must start at row and payload offset zero")
    if second["startRow"] != first["endRowExclusive"]:
        raise RuntimeError("selected tile row ranges must be contiguous")
    if second["artifactByteOffset"] != first["artifactByteOffset"] + first["byteLength"]:
        raise RuntimeError("selected tile payload ranges must be contiguous")

    return hidden_size, selected


def prepare(source_model: Path, source_external_data: Path, output_dir: Path) -> dict[str, object]:
    layout = layout_probe.build_report(source_model)
    if layout.get("kind") != layout_probe.REPORT_KIND or layout.get("schemaVersion") != layout_probe.REPORT_SCHEMA_VERSION:
        raise RuntimeError("unexpected upstream endpoint layout contract")
    if layout.get("status") != "pass" or layout.get("decisionStatus") != "diagnostic-only":
        raise RuntimeError("endpoint layout must pass and remain diagnostic-only")
    identity = layout.get("pinnedSourceExternalDataIdentity")
    if not isinstance(identity, dict) or identity.get("bytes") != PINNED_EXTERNAL_DATA_BYTES or identity.get("sha256") != PINNED_EXTERNAL_DATA_SHA256:
        raise RuntimeError("pinned source external-data identity drifted")

    hidden_size, selected_tiles = _preflight_preferred_tile_geometry(layout)

    source_fd, source_identity, source_hash = _open_pinned_source(source_external_data)
    try:
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

        manifest_tiles: list[dict[str, object]] = []
        for geometry in selected_tiles:
            tile_index = geometry["tileIndex"]
            rows = geometry["rowCount"]
            offset = geometry["artifactByteOffset"]
            length = geometry["byteLength"]

            graphs: dict[str, dict[str, object]] = {}
            for mode in ("embedding", "logits"):
                file_name = f"tile-{tile_index}-{mode}.onnx"
                graph_path = output_dir / file_name
                onnx.save(build_probe_model(mode=mode, rows=rows, hidden_size=hidden_size, offset=offset, length=length), graph_path)
                graph_bytes, graph_sha256 = _measure_regular_file(graph_path, check_onnx=True)
                graphs[mode] = {
                    "file": file_name,
                    "bytes": graph_bytes,
                    "sha256": graph_sha256,
                }
            manifest_tiles.append(
                {
                    "tileIndex": tile_index,
                    "startRow": geometry["startRow"],
                    "endRowExclusive": geometry["endRowExclusive"],
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
