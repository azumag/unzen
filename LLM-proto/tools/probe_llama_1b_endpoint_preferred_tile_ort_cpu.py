#!/usr/bin/env python3
"""Run diagnostic CPU ORT semantics for pinned 4-way endpoint payload tiles.

This S0 helper for issue #223 verifies that an 8-way execution tile can be
backed directly by a byte range inside the already-materialized 4-way preferred
physical payloads, without reconstructing the full tied embedding weight.
It exercises only the primitive tied-weight operations (Gather and
Transpose+MatMul) under pinned onnxruntime CPU. It does not select the 4-way
layout or establish ORT Web/WebGPU, browser-memory, cache, or full-model
numerical equivalence.
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
import stat
import tempfile
import time

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper

import probe_llama_1b_endpoint_layout_candidates as layout_probe


REPORT_KIND = "unzen-pinned-llama-1b-endpoint-preferred-tile-ort-cpu-probe"
REPORT_SCHEMA_VERSION = "1.0.0"
PINNED_ORT_VERSION = "1.22.0"
PREFERRED_PHYSICAL_ARTIFACT_COUNT = 4
EXECUTION_TILE_COUNT = 8
FLOAT32_BYTES = 4
ATOL = 1e-6
RTOL = 1e-6

# These hashes were obtained by byte-for-byte materialization from the pinned
# Llama-3.2-1B-Instruct q4 external-data source and independently recorded in
# #223. Keeping them here makes this execution spike fail closed if the physical
# payload bytes do not match that existing preferred-tier evidence.
PINNED_PREFERRED_PAYLOAD_SHA256 = {
    0: "b783704059e886b1e5438d23c3f9911b0d947c86125501c9071e5bb8f7cebdce",
    1: "6725be963565c84faaf487339c9b6020166077d62ffeae36467ce284c49cafb7",
    2: "21ea80f5829262b36028f32b17ef213090ff27ff708c6baa47277d45a99bff0a",
    3: "b2d23fbe273c8ae5f43c4ac4200613d3c88b0d11d389d2551a47af8649a688e9",
}


def _identity(snapshot: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        snapshot.st_dev,
        snapshot.st_ino,
        snapshot.st_size,
        snapshot.st_mtime_ns,
        snapshot.st_ctime_ns,
    )


def _open_pinned_payload(
    path: Path, *, expected_bytes: int, expected_sha256: str
) -> tuple[int, dict[str, object], tuple[int, int, int, int, int]]:
    try:
        path_snapshot = path.lstat()
    except FileNotFoundError as exc:
        raise RuntimeError(f"required physical payload is missing: {path.name}") from exc
    if stat.S_ISLNK(path_snapshot.st_mode):
        raise RuntimeError(f"physical payload must not be a symlink: {path.name}")
    if not stat.S_ISREG(path_snapshot.st_mode):
        raise RuntimeError(f"physical payload must be a regular file: {path.name}")
    if path_snapshot.st_size != expected_bytes:
        raise RuntimeError(
            f"physical payload {path.name} size mismatch: expected {expected_bytes}, got {path_snapshot.st_size}"
        )

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise RuntimeError(f"failed to pin physical payload: {path.name}: {exc}") from exc

    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise RuntimeError(f"opened physical payload is not regular: {path.name}")
        if _identity(opened) != _identity(path_snapshot):
            raise RuntimeError(f"physical payload changed while being opened: {path.name}")

        digest = hashlib.sha256()
        offset = 0
        while offset < opened.st_size:
            chunk = os.pread(fd, min(8 * 1024 * 1024, opened.st_size - offset), offset)
            if not chunk:
                raise RuntimeError(f"unexpected EOF while hashing physical payload: {path.name}")
            digest.update(chunk)
            offset += len(chunk)
        actual_sha256 = digest.hexdigest()
        if actual_sha256 != expected_sha256:
            raise RuntimeError(
                f"physical payload {path.name} SHA-256 mismatch: expected {expected_sha256}, got {actual_sha256}"
            )
        after = os.fstat(fd)
        pinned_identity = _identity(opened)
        if _identity(after) != pinned_identity:
            raise RuntimeError(f"physical payload changed while hashing: {path.name}")
        try:
            current_path = path.lstat()
        except FileNotFoundError as exc:
            raise RuntimeError(f"physical payload path disappeared while hashing: {path.name}") from exc
        if _identity(current_path) != pinned_identity:
            raise RuntimeError(f"physical payload path identity changed while hashing: {path.name}")
        return (
            fd,
            {
                "fileName": path.name,
                "byteLength": expected_bytes,
                "sha256": actual_sha256,
            },
            pinned_identity,
        )
    except Exception:
        os.close(fd)
        raise


def _assert_payload_path_identity(
    path: Path, *, pinned_identity: tuple[int, int, int, int, int]
) -> None:
    try:
        current = path.lstat()
    except FileNotFoundError as exc:
        raise RuntimeError(f"physical payload path disappeared during execution: {path.name}") from exc
    if _identity(current) != pinned_identity:
        raise RuntimeError(f"physical payload path identity changed during execution: {path.name}")


def _external_weight_tensor(
    *,
    name: str,
    rows: int,
    hidden_size: int,
    payload_location: str,
    payload_offset_bytes: int,
    byte_length: int,
) -> TensorProto:
    expected_bytes = rows * hidden_size * FLOAT32_BYTES
    if byte_length != expected_bytes:
        raise RuntimeError(
            f"tile external tensor byte length mismatch: expected {expected_bytes}, got {byte_length}"
        )
    tensor = TensorProto()
    tensor.name = name
    tensor.data_type = TensorProto.FLOAT
    tensor.dims.extend([rows, hidden_size])
    tensor.data_location = TensorProto.EXTERNAL
    for key, value in (
        ("location", payload_location),
        ("offset", str(payload_offset_bytes)),
        ("length", str(byte_length)),
    ):
        entry = tensor.external_data.add()
        entry.key = key
        entry.value = value
    return tensor


def _save_external_model(
    *,
    tile: dict[str, object],
    hidden_size: int,
    mode: str,
    payload_fd: int,
) -> Path:
    slices = tile.get("physicalSlices")
    if not isinstance(slices, list) or len(slices) != 1:
        raise RuntimeError("preferred 4-way execution tile must map to exactly one physical slice")
    physical_slice = slices[0]
    if not isinstance(physical_slice, dict):
        raise RuntimeError("physical slice must be an object")

    artifact_index = physical_slice.get("physicalArtifactIndex")
    row_count = physical_slice.get("rowCount")
    artifact_byte_offset = physical_slice.get("artifactByteOffset")
    byte_length = physical_slice.get("byteLength")
    if (
        not isinstance(artifact_index, int)
        or isinstance(artifact_index, bool)
        or artifact_index < 0
        or not isinstance(row_count, int)
        or isinstance(row_count, bool)
        or row_count <= 0
        or not isinstance(artifact_byte_offset, int)
        or isinstance(artifact_byte_offset, bool)
        or artifact_byte_offset < 0
        or not isinstance(byte_length, int)
        or isinstance(byte_length, bool)
        or byte_length <= 0
    ):
        raise RuntimeError("preferred tile physical slice geometry is invalid")

    initializer = _external_weight_tensor(
        name="tile_weight",
        rows=row_count,
        hidden_size=hidden_size,
        payload_location=f"/dev/fd/{payload_fd}",
        payload_offset_bytes=artifact_byte_offset,
        byte_length=byte_length,
    )

    if mode == "embedding":
        model_input = helper.make_tensor_value_info("local_ids", TensorProto.INT64, [None])
        model_output = helper.make_tensor_value_info(
            "embedding", TensorProto.FLOAT, [None, hidden_size]
        )
        nodes = [
            helper.make_node(
                "Gather", ["tile_weight", "local_ids"], ["embedding"], axis=0
            )
        ]
    elif mode == "logits":
        model_input = helper.make_tensor_value_info(
            "hidden", TensorProto.FLOAT, [1, hidden_size]
        )
        model_output = helper.make_tensor_value_info(
            "tile_logits", TensorProto.FLOAT, [1, row_count]
        )
        nodes = [
            helper.make_node(
                "Transpose", ["tile_weight"], ["tile_weight_transposed"], perm=[1, 0]
            ),
            helper.make_node(
                "MatMul", ["hidden", "tile_weight_transposed"], ["tile_logits"]
            ),
        ]
    else:
        raise RuntimeError(f"unsupported ORT tile mode: {mode}")

    graph = helper.make_graph(
        nodes,
        f"unzen-endpoint-tile-{mode}",
        [model_input],
        [model_output],
        [initializer],
    )
    model = helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 21)],
        ir_version=10,
        producer_name="unzen-diagnostic",
    )
    handle = tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=f".unzen-endpoint-tile-{mode}-",
        suffix=".onnx",
        delete=False,
    )
    model_path = Path(handle.name)
    handle.close()
    onnx.save(model, model_path)
    return model_path


def _session(model_path: Path) -> tuple[ort.InferenceSession, float]:
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    started = time.perf_counter()
    session = ort.InferenceSession(
        str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
    )
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    if session.get_providers() != ["CPUExecutionProvider"]:
        raise RuntimeError(f"unexpected ORT providers: {session.get_providers()!r}")
    return session, elapsed_ms


def _tile_view(
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


def _execute_tile(
    *,
    tile: dict[str, object],
    hidden_size: int,
    payload_fd: int,
) -> dict[str, object]:
    tile_index = tile.get("tileIndex")
    start_row = tile.get("startRow")
    end_row = tile.get("endRowExclusive")
    row_count = tile.get("rowCount")
    slices = tile.get("physicalSlices")
    if (
        not isinstance(tile_index, int)
        or isinstance(tile_index, bool)
        or tile_index < 0
        or not isinstance(start_row, int)
        or isinstance(start_row, bool)
        or start_row < 0
        or not isinstance(end_row, int)
        or isinstance(end_row, bool)
        or end_row <= start_row
        or not isinstance(row_count, int)
        or isinstance(row_count, bool)
        or row_count != end_row - start_row
        or not isinstance(slices, list)
        or len(slices) != 1
        or not isinstance(slices[0], dict)
    ):
        raise RuntimeError("preferred execution tile geometry is invalid")

    physical_slice = slices[0]
    artifact_index = physical_slice.get("physicalArtifactIndex")
    artifact_offset = physical_slice.get("artifactByteOffset")
    slice_rows = physical_slice.get("rowCount")
    if (
        not isinstance(artifact_index, int)
        or isinstance(artifact_index, bool)
        or not isinstance(artifact_offset, int)
        or isinstance(artifact_offset, bool)
        or artifact_offset < 0
        or slice_rows != row_count
    ):
        raise RuntimeError("preferred execution tile physical slice is invalid")

    mapped, weight = _tile_view(
        payload_fd=payload_fd,
        artifact_byte_offset=artifact_offset,
        rows=row_count,
        hidden_size=hidden_size,
    )
    try:
        local_ids = np.array(
            sorted({0, row_count // 2, row_count - 1}), dtype=np.int64
        )
        expected_embedding = np.asarray(weight[local_ids]).copy()
        embedding_model = _save_external_model(
            tile=tile,
            hidden_size=hidden_size,
            mode="embedding",
            payload_fd=payload_fd,
        )
        try:
            embedding_session, embedding_create_ms = _session(embedding_model)
            started = time.perf_counter()
            actual_embedding = embedding_session.run(None, {"local_ids": local_ids})[0]
            embedding_run_ms = (time.perf_counter() - started) * 1000.0
            embedding_exact = np.array_equal(actual_embedding, expected_embedding)
            embedding_max_abs = float(
                np.max(np.abs(actual_embedding - expected_embedding), initial=0.0)
            )
            if not embedding_exact:
                raise RuntimeError(
                    f"tile {tile_index} embedding Gather diverged from payload bytes; "
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
        base_coefficients = [
            np.float32(0.5),
            np.float32(-0.25),
            np.float32(0.125),
        ]
        coefficients = base_coefficients[: len(columns)]
        for column, coefficient in zip(columns, coefficients, strict=True):
            hidden[0, column] = coefficient
        expected_logits = np.zeros((row_count,), dtype=np.float32)
        for column, coefficient in zip(columns, coefficients, strict=True):
            expected_logits += np.asarray(weight[:, column]) * coefficient

        logits_model = _save_external_model(
            tile=tile,
            hidden_size=hidden_size,
            mode="logits",
            payload_fd=payload_fd,
        )
        try:
            logits_session, logits_create_ms = _session(logits_model)
            started = time.perf_counter()
            actual_logits = logits_session.run(None, {"hidden": hidden})[0][0]
            logits_run_ms = (time.perf_counter() - started) * 1000.0
            diff = np.abs(actual_logits - expected_logits)
            logits_max_abs = float(np.max(diff, initial=0.0))
            denominator = np.maximum(np.abs(expected_logits), np.float32(1e-12))
            logits_max_relative = float(np.max(diff / denominator, initial=0.0))
            logits_close = bool(
                np.allclose(actual_logits, expected_logits, atol=ATOL, rtol=RTOL)
            )
            if not logits_close:
                raise RuntimeError(
                    f"tile {tile_index} logits MatMul diverged from sparse payload "
                    f"reference; max abs diff={logits_max_abs}, "
                    f"max relative diff={logits_max_relative}"
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
            "physicalArtifactIndex": artifact_index,
            "artifactByteOffset": artifact_offset,
            "byteLength": physical_slice.get("byteLength"),
            "embedding": {
                "selectedGlobalTokenIds": [
                    start_row + int(value) for value in local_ids
                ],
                "selectedLocalTokenIds": [int(value) for value in local_ids],
                "exactEqual": embedding_exact,
                "maxAbsDiff": embedding_max_abs,
                "sessionCreateMs": embedding_create_ms,
                "runMs": embedding_run_ms,
            },
            "logits": {
                "sparseHiddenColumns": columns,
                "sparseHiddenCoefficients": [
                    float(value) for value in coefficients
                ],
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
        del weight
        mapped.close()
        gc.collect()


def build_report(
    source_model_path: Path,
    payload_root: Path,
    *,
    tile_indices: list[int],
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
    preferred_candidates = [
        candidate
        for candidate in candidates
        if isinstance(candidate, dict)
        and candidate.get("physicalArtifactCount") == PREFERRED_PHYSICAL_ARTIFACT_COUNT
    ]
    if len(preferred_candidates) != 1:
        raise RuntimeError("expected exactly one pinned 4-way preferred candidate")
    candidate = preferred_candidates[0]
    tiles = candidate.get("executionTiles")
    physical = candidate.get("physicalArtifacts")
    if not isinstance(tiles, list) or len(tiles) != EXECUTION_TILE_COUNT:
        raise RuntimeError("pinned preferred candidate must expose exactly eight execution tiles")
    if not isinstance(physical, list) or len(physical) != PREFERRED_PHYSICAL_ARTIFACT_COUNT:
        raise RuntimeError("pinned preferred candidate must expose exactly four physical artifacts")

    if not tile_indices:
        raise RuntimeError("at least one execution tile must be selected")
    if len(set(tile_indices)) != len(tile_indices):
        raise RuntimeError("execution tile selection must not contain duplicates")
    selected_tiles: list[dict[str, object]] = []
    for tile_index in tile_indices:
        if not isinstance(tile_index, int) or isinstance(tile_index, bool):
            raise RuntimeError("execution tile index must be an integer")
        if tile_index < 0 or tile_index >= len(tiles):
            raise RuntimeError(f"execution tile index out of range: {tile_index}")
        tile = tiles[tile_index]
        if not isinstance(tile, dict) or tile.get("tileIndex") != tile_index:
            raise RuntimeError(f"execution tile index contract drift at {tile_index}")
        if tile.get("physicalArtifactCount") != 1:
            raise RuntimeError(
                f"preferred 4-way execution tile {tile_index} no longer maps to one physical artifact"
            )
        selected_tiles.append(tile)

    physical_by_index: dict[int, dict[str, object]] = {}
    for artifact in physical:
        if not isinstance(artifact, dict):
            raise RuntimeError("physical artifact entry must be an object")
        index = artifact.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or index < 0:
            raise RuntimeError("physical artifact index must be non-negative")
        if index in physical_by_index:
            raise RuntimeError(f"duplicate physical artifact index {index}")
        physical_by_index[index] = artifact

    required_indices = sorted(
        {
            int(tile["physicalSlices"][0]["physicalArtifactIndex"])
            for tile in selected_tiles
        }
    )
    verified_payloads = []
    pinned_payloads: dict[int, tuple[int, Path, tuple[int, int, int, int, int]]] = {}
    try:
        for index in required_indices:
            artifact = physical_by_index.get(index)
            if artifact is None:
                raise RuntimeError(f"execution tile references unknown physical artifact {index}")
            byte_length = artifact.get("byteLength")
            if not isinstance(byte_length, int) or isinstance(byte_length, bool) or byte_length <= 0:
                raise RuntimeError(f"physical artifact {index} byteLength is invalid")
            expected_sha256 = PINNED_PREFERRED_PAYLOAD_SHA256.get(index)
            if expected_sha256 is None:
                raise RuntimeError(f"missing pinned SHA-256 contract for physical artifact {index}")
            payload_path = payload_root / f"payload-{index:04d}.bin"
            fd, verified, pinned_identity = _open_pinned_payload(
                payload_path,
                expected_bytes=byte_length,
                expected_sha256=expected_sha256,
            )
            verified["physicalArtifactIndex"] = index
            verified_payloads.append(verified)
            pinned_payloads[index] = (fd, payload_path, pinned_identity)

        tile_results = []
        for tile in selected_tiles:
            artifact_index = int(tile["physicalSlices"][0]["physicalArtifactIndex"])
            fd, _, _ = pinned_payloads[artifact_index]
            tile_results.append(
                _execute_tile(tile=tile, hidden_size=hidden_size, payload_fd=fd)
            )

        for _, payload_path, pinned_identity in pinned_payloads.values():
            _assert_payload_path_identity(payload_path, pinned_identity=pinned_identity)

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
            "physicalArtifactCount": PREFERRED_PHYSICAL_ARTIFACT_COUNT,
            "executionTileCount": EXECUTION_TILE_COUNT,
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
            "verifiedPhysicalPayloads": verified_payloads,
            "executedTiles": tile_results,
            "conclusion": (
                "The selected 8-way vocabulary-row execution tiles ran the primitive "
                "tied-weight embedding Gather and logits Transpose+MatMul under pinned "
                "onnxruntime CPU while binding directly to byte ranges inside the previously "
                "materialized 4-way preferred physical payloads. This is stage-local CPU "
                "feasibility only: it does not select the 4-way architecture, exercise final "
                "norm, prove full-model equivalence, establish ORT Web/WebGPU range binding, "
                "measure browser host/GPU working set, or define manifest/cache/runtime/"
                "dispatcher semantics."
            ),
        }

    finally:
        for fd, _, _ in pinned_payloads.values():
            try:
                os.close(fd)
            except OSError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path)
    parser.add_argument("payload_root", type=Path)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--tile-index", type=int, action="append", dest="tile_indices")
    selection.add_argument("--all-tiles", action="store_true")
    args = parser.parse_args()
    tile_indices = list(range(EXECUTION_TILE_COUNT)) if args.all_tiles else args.tile_indices
    print(
        json.dumps(
            build_report(args.source_model, args.payload_root, tile_indices=tile_indices),
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
