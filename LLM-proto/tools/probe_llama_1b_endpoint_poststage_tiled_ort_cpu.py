#!/usr/bin/env python3
"""Compare pinned Llama 1B source post-stage logits with an 8-tile CPU ORT composition.

This issue #223 S0 diagnostic keeps the final SkipSimplifiedLayerNormalization
stage intact, but replaces the tied full-vocabulary lm_head weight with the
existing diagnostic 8-way execution-tile ranges backed by four preferred-tier
physical payload files.  It compares the complete logits tensor with a
reference graph reconstructed from the pinned source post-stage topology.

The probe is deliberately diagnostic-only.  It does not select the 4-way
physical / 8-way execution layout, prove full-model multi-segment equivalence,
exercise ORT Web/WebGPU, measure browser memory/reclamation, or define cache,
manifest, loader, runtime, or dispatcher semantics.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
from pathlib import Path
import platform
import tempfile
import time
from typing import Iterable

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper

import probe_llama_1b_endpoint_layout_candidates as layout_probe
import probe_llama_1b_endpoint_preferred_tile_ort_cpu as preferred_probe


REPORT_KIND = "unzen-pinned-llama-1b-endpoint-poststage-tiled-ort-cpu-probe"
REPORT_SCHEMA_VERSION = "1.0.0"
PINNED_ORT_VERSION = preferred_probe.PINNED_ORT_VERSION
PHYSICAL_ARTIFACT_COUNT = 4
EXECUTION_TILE_COUNT = 8
FLOAT32_BYTES = preferred_probe.FLOAT32_BYTES
ATOL = preferred_probe.ATOL
RTOL = preferred_probe.RTOL

FINAL_NORM_NODE_NAME = "/model/layers.16/final_norm_layernorm/SkipLayerNorm"
FINAL_NORM_OP_TYPE = "SkipSimplifiedLayerNormalization"
FINAL_NORM_DOMAIN = "com.microsoft"
FINAL_NORM_INPUTS = (
    "/model/layers.15/post_attention_layernorm/output_3",
    "/model/layers.15/mlp/down_proj/MatMul/output_0",
    "model.layers.16.final_norm_layernorm.weight",
)
FINAL_NORM_OUTPUT = "/model/layers.16/final_norm_layernorm/output_0"
FINAL_NORM_EPSILON = float(np.float32(1e-5))
LM_HEAD_TRANSPOSE_NODE_NAME = "/lm_head/Transpose"
LM_HEAD_MATMUL_NODE_NAME = "/lm_head/MatMul"
TIED_WEIGHT_NAME = "model.embed_tokens.weight"
LOGITS_OUTPUT = "logits"
EXPECTED_TIED_WEIGHT_OFFSET = 0
EXPECTED_TIED_WEIGHT_BYTES = 1_050_673_152
EXPECTED_FINAL_NORM_WEIGHT_OFFSET = 1_084_489_728
EXPECTED_FINAL_NORM_WEIGHT_BYTES = 8_192
EXPECTED_SOURCE_LOCATION = "model_q4.onnx_data"


def _external_data_map(tensor: TensorProto) -> dict[str, str]:
    return {entry.key: entry.value for entry in tensor.external_data}


def _required_int_text(value: str | None, *, field: str) -> int:
    if value is None:
        raise RuntimeError(f"missing external-data field: {field}")
    try:
        parsed = int(value)
    except ValueError as exc:
        raise RuntimeError(f"external-data field {field} must be an integer") from exc
    if parsed < 0:
        raise RuntimeError(f"external-data field {field} must be non-negative")
    return parsed


def _unique_node(model: onnx.ModelProto, name: str) -> onnx.NodeProto:
    matches = [node for node in model.graph.node if node.name == name]
    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one source node {name!r}; found {len(matches)}")
    return matches[0]


def _unique_initializer(model: onnx.ModelProto, name: str) -> TensorProto:
    matches = [value for value in model.graph.initializer if value.name == name]
    if len(matches) != 1:
        raise RuntimeError(
            f"expected exactly one source initializer {name!r}; found {len(matches)}"
        )
    return matches[0]


def _float_attribute(node: onnx.NodeProto, name: str) -> float:
    matches = [attribute for attribute in node.attribute if attribute.name == name]
    if len(matches) != 1 or matches[0].type != onnx.AttributeProto.FLOAT:
        raise RuntimeError(f"source node {node.name!r} must have one float attribute {name!r}")
    return float(matches[0].f)


def _ints_attribute(node: onnx.NodeProto, name: str) -> tuple[int, ...]:
    matches = [attribute for attribute in node.attribute if attribute.name == name]
    if len(matches) != 1 or matches[0].type != onnx.AttributeProto.INTS:
        raise RuntimeError(f"source node {node.name!r} must have one ints attribute {name!r}")
    return tuple(int(value) for value in matches[0].ints)


def _poststage_contract(
    model: onnx.ModelProto, *, rows: int, hidden_size: int
) -> dict[str, object]:
    final_norm = _unique_node(model, FINAL_NORM_NODE_NAME)
    if final_norm.op_type != FINAL_NORM_OP_TYPE or final_norm.domain != FINAL_NORM_DOMAIN:
        raise RuntimeError("pinned final-norm operator contract drift")
    if tuple(final_norm.input) != FINAL_NORM_INPUTS or tuple(final_norm.output) != (
        FINAL_NORM_OUTPUT,
    ):
        raise RuntimeError("pinned final-norm input/output contract drift")
    epsilon = _float_attribute(final_norm, "epsilon")
    if epsilon != FINAL_NORM_EPSILON:
        raise RuntimeError(
            f"pinned final-norm epsilon drift: expected {FINAL_NORM_EPSILON}, got {epsilon}"
        )

    transpose = _unique_node(model, LM_HEAD_TRANSPOSE_NODE_NAME)
    if transpose.op_type != "Transpose" or transpose.domain != "":
        raise RuntimeError("pinned lm_head Transpose operator contract drift")
    if tuple(transpose.input) != (TIED_WEIGHT_NAME,) or len(transpose.output) != 1:
        raise RuntimeError("pinned lm_head Transpose input/output contract drift")
    if _ints_attribute(transpose, "perm") != (1, 0):
        raise RuntimeError("pinned lm_head Transpose permutation drift")

    matmul = _unique_node(model, LM_HEAD_MATMUL_NODE_NAME)
    if matmul.op_type != "MatMul" or matmul.domain != "":
        raise RuntimeError("pinned lm_head MatMul operator contract drift")
    if tuple(matmul.input) != (FINAL_NORM_OUTPUT, transpose.output[0]) or tuple(
        matmul.output
    ) != (LOGITS_OUTPUT,):
        raise RuntimeError("pinned lm_head MatMul input/output contract drift")

    tied = _unique_initializer(model, TIED_WEIGHT_NAME)
    norm_weight = _unique_initializer(model, FINAL_NORM_INPUTS[2])
    if tied.data_type != TensorProto.FLOAT or tuple(tied.dims) != (rows, hidden_size):
        raise RuntimeError("pinned tied-weight dtype/shape contract drift")
    if norm_weight.data_type != TensorProto.FLOAT or tuple(norm_weight.dims) != (
        hidden_size,
    ):
        raise RuntimeError("pinned final-norm weight dtype/shape contract drift")
    if tied.data_location != TensorProto.EXTERNAL or norm_weight.data_location != TensorProto.EXTERNAL:
        raise RuntimeError("pinned post-stage initializers must remain external")

    tied_external = _external_data_map(tied)
    norm_external = _external_data_map(norm_weight)
    if tied_external.get("location") != EXPECTED_SOURCE_LOCATION:
        raise RuntimeError("pinned tied-weight external-data location drift")
    if norm_external.get("location") != EXPECTED_SOURCE_LOCATION:
        raise RuntimeError("pinned final-norm external-data location drift")
    tied_offset = _required_int_text(tied_external.get("offset"), field="tied.offset")
    tied_bytes = _required_int_text(tied_external.get("length"), field="tied.length")
    norm_offset = _required_int_text(norm_external.get("offset"), field="norm.offset")
    norm_bytes = _required_int_text(norm_external.get("length"), field="norm.length")
    if tied_bytes != rows * hidden_size * FLOAT32_BYTES:
        raise RuntimeError("pinned tied-weight external byte length does not match shape")
    if norm_bytes != hidden_size * FLOAT32_BYTES:
        raise RuntimeError("pinned final-norm external byte length does not match shape")

    return {
        "finalNorm": {
            "nodeName": final_norm.name,
            "opType": final_norm.op_type,
            "domain": final_norm.domain,
            "inputs": list(final_norm.input),
            "output": final_norm.output[0],
            "epsilon": epsilon,
            "weight": {
                "name": norm_weight.name,
                "sourceOffsetBytes": norm_offset,
                "byteLength": norm_bytes,
            },
        },
        "lmHead": {
            "transposeNodeName": transpose.name,
            "matMulNodeName": matmul.name,
            "tiedWeight": {
                "name": tied.name,
                "rows": rows,
                "hiddenSize": hidden_size,
                "sourceOffsetBytes": tied_offset,
                "byteLength": tied_bytes,
            },
            "output": LOGITS_OUTPUT,
        },
    }


def _validate_pinned_poststage_offsets(contract: dict[str, object]) -> None:
    final_norm = contract["finalNorm"]
    lm_head = contract["lmHead"]
    assert isinstance(final_norm, dict) and isinstance(lm_head, dict)
    norm_weight = final_norm["weight"]
    tied_weight = lm_head["tiedWeight"]
    assert isinstance(norm_weight, dict) and isinstance(tied_weight, dict)
    expected = {
        "tied offset": (tied_weight["sourceOffsetBytes"], EXPECTED_TIED_WEIGHT_OFFSET),
        "tied bytes": (tied_weight["byteLength"], EXPECTED_TIED_WEIGHT_BYTES),
        "norm offset": (
            norm_weight["sourceOffsetBytes"],
            EXPECTED_FINAL_NORM_WEIGHT_OFFSET,
        ),
        "norm bytes": (norm_weight["byteLength"], EXPECTED_FINAL_NORM_WEIGHT_BYTES),
    }
    for field, (observed, pinned) in expected.items():
        if observed != pinned:
            raise RuntimeError(
                f"pinned post-stage external-data {field} drift: expected {pinned}, got {observed}"
            )


def _external_tensor(
    *, name: str, dims: Iterable[int], location: str, offset: int, length: int
) -> TensorProto:
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


def _model_io(hidden_size: int, rows: int) -> tuple[list[onnx.ValueInfoProto], list[onnx.ValueInfoProto]]:
    inputs = [
        helper.make_tensor_value_info(FINAL_NORM_INPUTS[0], TensorProto.FLOAT, [1, 1, hidden_size]),
        helper.make_tensor_value_info(FINAL_NORM_INPUTS[1], TensorProto.FLOAT, [1, 1, hidden_size]),
    ]
    outputs = [
        helper.make_tensor_value_info(LOGITS_OUTPUT, TensorProto.FLOAT, [1, 1, rows]),
        helper.make_tensor_value_info(FINAL_NORM_OUTPUT, TensorProto.FLOAT, [1, 1, hidden_size]),
    ]
    return inputs, outputs


def _final_norm_node(epsilon: float) -> onnx.NodeProto:
    return helper.make_node(
        FINAL_NORM_OP_TYPE,
        list(FINAL_NORM_INPUTS),
        [FINAL_NORM_OUTPUT],
        name=FINAL_NORM_NODE_NAME,
        domain=FINAL_NORM_DOMAIN,
        epsilon=epsilon,
    )


def _save_model(model: onnx.ModelProto, *, prefix: str) -> Path:
    handle = tempfile.NamedTemporaryFile(mode="wb", prefix=prefix, suffix=".onnx", delete=False)
    path = Path(handle.name)
    handle.close()
    onnx.save_model(model, str(path))
    return path


def _build_reference_model(
    *, contract: dict[str, object], source_fd: int, hidden_size: int, rows: int
) -> Path:
    final_norm = contract["finalNorm"]
    lm_head = contract["lmHead"]
    assert isinstance(final_norm, dict) and isinstance(lm_head, dict)
    norm_weight = final_norm["weight"]
    tied_weight = lm_head["tiedWeight"]
    assert isinstance(norm_weight, dict) and isinstance(tied_weight, dict)
    initializers = [
        _external_tensor(
            name=FINAL_NORM_INPUTS[2],
            dims=[hidden_size],
            location=f"/dev/fd/{source_fd}",
            offset=int(norm_weight["sourceOffsetBytes"]),
            length=int(norm_weight["byteLength"]),
        ),
        _external_tensor(
            name=TIED_WEIGHT_NAME,
            dims=[rows, hidden_size],
            location=f"/dev/fd/{source_fd}",
            offset=int(tied_weight["sourceOffsetBytes"]),
            length=int(tied_weight["byteLength"]),
        ),
    ]
    nodes = [
        _final_norm_node(float(final_norm["epsilon"])),
        helper.make_node(
            "Transpose", [TIED_WEIGHT_NAME], ["reference_weight_t"], perm=[1, 0]
        ),
        helper.make_node(
            "MatMul", [FINAL_NORM_OUTPUT, "reference_weight_t"], [LOGITS_OUTPUT]
        ),
    ]
    inputs, outputs = _model_io(hidden_size, rows)
    graph = helper.make_graph(nodes, "unzen-endpoint-poststage-reference", inputs, outputs, initializers)
    model = helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 21), helper.make_opsetid("com.microsoft", 1)],
        ir_version=10,
        producer_name="unzen-diagnostic",
    )
    return _save_model(model, prefix=".unzen-endpoint-poststage-reference-")


def _build_tiled_model(
    *,
    contract: dict[str, object],
    payload_fds: dict[int, int],
    execution_tiles: list[dict[str, object]],
    source_fd: int,
    hidden_size: int,
    rows: int,
) -> Path:
    final_norm = contract["finalNorm"]
    assert isinstance(final_norm, dict)
    norm_weight = final_norm["weight"]
    assert isinstance(norm_weight, dict)
    initializers = [
        _external_tensor(
            name=FINAL_NORM_INPUTS[2],
            dims=[hidden_size],
            location=f"/dev/fd/{source_fd}",
            offset=int(norm_weight["sourceOffsetBytes"]),
            length=int(norm_weight["byteLength"]),
        )
    ]
    nodes: list[onnx.NodeProto] = [_final_norm_node(float(final_norm["epsilon"]))]
    tile_outputs: list[str] = []
    expected_row = 0
    for expected_index, tile in enumerate(execution_tiles):
        if tile.get("tileIndex") != expected_index or tile.get("startRow") != expected_row:
            raise RuntimeError("execution tiles must be ordered and row-contiguous")
        row_count = tile.get("rowCount")
        end_row = tile.get("endRowExclusive")
        slices = tile.get("physicalSlices")
        if (
            not isinstance(row_count, int)
            or isinstance(row_count, bool)
            or row_count <= 0
            or not isinstance(end_row, int)
            or isinstance(end_row, bool)
            or end_row != expected_row + row_count
            or not isinstance(slices, list)
            or len(slices) != 1
            or not isinstance(slices[0], dict)
        ):
            raise RuntimeError(f"invalid execution tile geometry at index {expected_index}")
        physical_slice = slices[0]
        artifact_index = physical_slice.get("physicalArtifactIndex")
        artifact_offset = physical_slice.get("artifactByteOffset")
        byte_length = physical_slice.get("byteLength")
        if (
            not isinstance(artifact_index, int)
            or isinstance(artifact_index, bool)
            or artifact_index not in payload_fds
            or not isinstance(artifact_offset, int)
            or isinstance(artifact_offset, bool)
            or artifact_offset < 0
            or not isinstance(byte_length, int)
            or isinstance(byte_length, bool)
            or byte_length != row_count * hidden_size * FLOAT32_BYTES
        ):
            raise RuntimeError(f"invalid physical slice geometry at tile {expected_index}")
        weight_name = f"tile_weight_{expected_index}"
        transposed_name = f"tile_weight_t_{expected_index}"
        logits_name = f"tile_logits_{expected_index}"
        initializers.append(
            _external_tensor(
                name=weight_name,
                dims=[row_count, hidden_size],
                location=f"/dev/fd/{payload_fds[artifact_index]}",
                offset=artifact_offset,
                length=byte_length,
            )
        )
        nodes.append(helper.make_node("Transpose", [weight_name], [transposed_name], perm=[1, 0]))
        nodes.append(helper.make_node("MatMul", [FINAL_NORM_OUTPUT, transposed_name], [logits_name]))
        tile_outputs.append(logits_name)
        expected_row = end_row
    if expected_row != rows:
        raise RuntimeError(f"execution tiles do not cover full vocabulary rows: {expected_row} != {rows}")
    nodes.append(helper.make_node("Concat", tile_outputs, [LOGITS_OUTPUT], axis=2))
    inputs, outputs = _model_io(hidden_size, rows)
    graph = helper.make_graph(nodes, "unzen-endpoint-poststage-tiled", inputs, outputs, initializers)
    model = helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 21), helper.make_opsetid("com.microsoft", 1)],
        ir_version=10,
        producer_name="unzen-diagnostic",
    )
    return _save_model(model, prefix=".unzen-endpoint-poststage-tiled-")


def _session(model_path: Path) -> tuple[ort.InferenceSession, float]:
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    started = time.perf_counter()
    session = ort.InferenceSession(
        str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
    )
    create_ms = (time.perf_counter() - started) * 1000.0
    if session.get_providers() != ["CPUExecutionProvider"]:
        raise RuntimeError(f"unexpected ORT providers: {session.get_providers()!r}")
    return session, create_ms


def _inputs(hidden_size: int) -> dict[str, np.ndarray]:
    columns = np.arange(hidden_size, dtype=np.float32)
    residual = (((columns % np.float32(23.0)) - np.float32(11.0)) / np.float32(32.0)).reshape(
        1, 1, hidden_size
    )
    update = (
        (((columns * np.float32(7.0)) % np.float32(29.0)) - np.float32(14.0))
        / np.float32(64.0)
    ).reshape(1, 1, hidden_size)
    return {FINAL_NORM_INPUTS[0]: residual, FINAL_NORM_INPUTS[1]: update}


def _run_model(model_path: Path, feeds: dict[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
    session, create_ms = _session(model_path)
    try:
        started = time.perf_counter()
        logits, normalized = session.run([LOGITS_OUTPUT, FINAL_NORM_OUTPUT], feeds)
        run_ms = (time.perf_counter() - started) * 1000.0
        return logits, normalized, {"sessionCreateMs": create_ms, "runMs": run_ms}
    finally:
        del session
        gc.collect()


def _comparison(actual: np.ndarray, expected: np.ndarray) -> dict[str, object]:
    if actual.shape != expected.shape:
        raise RuntimeError(f"comparison shape mismatch: {actual.shape!r} != {expected.shape!r}")
    diff = np.abs(actual - expected)
    max_abs = float(np.max(diff, initial=0.0))
    denominator = np.maximum(np.abs(expected), np.float32(1e-12))
    max_relative = float(np.max(diff / denominator, initial=0.0))
    exact = bool(np.array_equal(actual, expected))
    close = bool(np.allclose(actual, expected, atol=ATOL, rtol=RTOL))
    return {
        "shape": list(actual.shape),
        "exactEqual": exact,
        "allClose": close,
        "atol": ATOL,
        "rtol": RTOL,
        "maxAbsDiff": max_abs,
        "maxRelativeDiff": max_relative,
    }


def _sha256_fd_range(fd: int, *, offset: int, length: int) -> str:
    if offset < 0 or length <= 0:
        raise RuntimeError("hash range must have non-negative offset and positive length")
    digest = hashlib.sha256()
    cursor = 0
    while cursor < length:
        chunk = os.pread(fd, min(8 * 1024 * 1024, length - cursor), offset + cursor)
        if not chunk:
            raise RuntimeError("unexpected EOF while hashing pinned source range")
        digest.update(chunk)
        cursor += len(chunk)
    return digest.hexdigest()


def _load_pinned_source_model(
    source_model_path: Path, *, expected_sha256: str
) -> tuple[int, onnx.ModelProto, dict[str, object], tuple[int, int, int, int, int]]:
    if len(expected_sha256) != 64:
        raise RuntimeError("upstream layout source graph SHA-256 is invalid")
    try:
        expected_bytes = source_model_path.lstat().st_size
    except FileNotFoundError as exc:
        raise RuntimeError("pinned source graph is missing") from exc
    fd, verified, pinned_identity = preferred_probe._open_pinned_payload(
        source_model_path,
        expected_bytes=expected_bytes,
        expected_sha256=expected_sha256,
    )
    try:
        raw = bytearray()
        cursor = 0
        while cursor < expected_bytes:
            chunk = os.pread(fd, min(1024 * 1024, expected_bytes - cursor), cursor)
            if not chunk:
                raise RuntimeError("unexpected EOF while reading pinned source graph")
            raw.extend(chunk)
            cursor += len(chunk)
        if preferred_probe._identity(os.fstat(fd)) != pinned_identity:
            raise RuntimeError("pinned source graph changed while being parsed")
        model = onnx.load_model_from_string(bytes(raw))
        verified["role"] = "pinned-source-graph"
        return fd, model, verified, pinned_identity
    except Exception:
        os.close(fd)
        raise


def _validate_layout(layout: dict[str, object]) -> tuple[int, int, list[dict[str, object]], list[dict[str, object]]]:
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
    rows = layout.get("rows")
    if not isinstance(rows, int) or isinstance(rows, bool) or rows <= 0:
        raise RuntimeError("pinned endpoint rows must be positive")
    candidates = layout.get("candidates")
    if not isinstance(candidates, list):
        raise RuntimeError("endpoint layout candidates must be an array")
    selected = [
        value
        for value in candidates
        if isinstance(value, dict) and value.get("physicalArtifactCount") == PHYSICAL_ARTIFACT_COUNT
    ]
    if len(selected) != 1:
        raise RuntimeError("expected exactly one pinned 4-way preferred candidate")
    physical = selected[0].get("physicalArtifacts")
    tiles = selected[0].get("executionTiles")
    if not isinstance(physical, list) or len(physical) != PHYSICAL_ARTIFACT_COUNT:
        raise RuntimeError("pinned preferred candidate must expose exactly four physical artifacts")
    if not isinstance(tiles, list) or len(tiles) != EXECUTION_TILE_COUNT:
        raise RuntimeError("pinned preferred candidate must expose exactly eight execution tiles")
    if not all(isinstance(value, dict) for value in physical + tiles):
        raise RuntimeError("layout physical artifacts and execution tiles must be objects")
    return rows, hidden_size, physical, tiles  # type: ignore[return-value]


def build_report(source_model_path: Path, source_external_data: Path, payload_root: Path) -> dict[str, object]:
    if ort.__version__ != PINNED_ORT_VERSION:
        raise RuntimeError(
            f"onnxruntime version drift: expected {PINNED_ORT_VERSION}, got {ort.__version__}"
        )
    if os.name != "posix" or not Path("/dev/fd").is_dir():
        raise RuntimeError("pinned post-stage execution requires POSIX /dev/fd support")
    payload_root = payload_root.resolve()
    if not payload_root.is_dir():
        raise RuntimeError("payload root must be an existing directory")

    layout = layout_probe.build_report(source_model_path)
    rows, hidden_size, physical, tiles = _validate_layout(layout)
    source_identity = layout.get("pinnedSourceExternalDataIdentity")
    if not isinstance(source_identity, dict):
        raise RuntimeError("layout report must include pinned source external-data identity")
    source_bytes = source_identity.get("bytes")
    if source_bytes is None:
        source_bytes = source_identity.get("sizeBytes")
    source_sha256 = source_identity.get("sha256")
    if (
        not isinstance(source_bytes, int)
        or isinstance(source_bytes, bool)
        or source_bytes <= 0
        or not isinstance(source_sha256, str)
        or len(source_sha256) != 64
    ):
        raise RuntimeError("layout pinned source external-data identity is invalid")

    source_graph_sha256 = layout.get("sourceGraphSha256")
    if not isinstance(source_graph_sha256, str):
        raise RuntimeError("layout report must include sourceGraphSha256")

    source_model_fd = -1
    source_model_path_identity: tuple[int, int, int, int, int] | None = None
    source_fd = -1
    payloads: dict[int, tuple[int, Path, tuple[int, int, int, int, int]]] = {}
    reference_model: Path | None = None
    tiled_model: Path | None = None
    try:
        (
            source_model_fd,
            model,
            verified_source_graph,
            source_model_path_identity,
        ) = _load_pinned_source_model(
            source_model_path, expected_sha256=source_graph_sha256
        )
        contract = _poststage_contract(model, rows=rows, hidden_size=hidden_size)
        _validate_pinned_poststage_offsets(contract)

        source_fd, verified_source, source_path_identity = preferred_probe._open_pinned_payload(
            source_external_data,
            expected_bytes=source_bytes,
            expected_sha256=source_sha256,
        )
        verified_source["role"] = "pinned-source-external-data"

        verified_payloads: list[dict[str, object]] = []
        for artifact in physical:
            index = artifact.get("index")
            byte_length = artifact.get("byteLength")
            source_offset = artifact.get("sourceOffsetBytes")
            if (
                not isinstance(index, int)
                or isinstance(index, bool)
                or index < 0
                or not isinstance(byte_length, int)
                or isinstance(byte_length, bool)
                or byte_length <= 0
                or not isinstance(source_offset, int)
                or isinstance(source_offset, bool)
                or source_offset < 0
            ):
                raise RuntimeError("preferred physical artifact geometry is invalid")
            expected_sha256 = preferred_probe.PINNED_PREFERRED_PAYLOAD_SHA256.get(index)
            if expected_sha256 is None:
                raise RuntimeError(f"missing pinned SHA-256 for physical artifact {index}")
            payload_path = payload_root / f"payload-{index:04d}.bin"
            fd, verified, path_identity = preferred_probe._open_pinned_payload(
                payload_path,
                expected_bytes=byte_length,
                expected_sha256=expected_sha256,
            )
            source_range_sha256 = _sha256_fd_range(
                source_fd, offset=source_offset, length=byte_length
            )
            if source_range_sha256 != verified["sha256"]:
                os.close(fd)
                raise RuntimeError(
                    f"physical artifact {index} does not match pinned source byte range"
                )
            verified.update(
                {
                    "physicalArtifactIndex": index,
                    "sourceOffsetBytes": source_offset,
                    "sourceEndOffsetBytesExclusive": source_offset + byte_length,
                    "matchesPinnedSourceRange": True,
                }
            )
            verified_payloads.append(verified)
            payloads[index] = (fd, payload_path, path_identity)

        norm_weight = contract["finalNorm"]["weight"]  # type: ignore[index]
        norm_sha256 = _sha256_fd_range(
            source_fd,
            offset=int(norm_weight["sourceOffsetBytes"]),  # type: ignore[index]
            length=int(norm_weight["byteLength"]),  # type: ignore[index]
        )

        payload_fds = {index: value[0] for index, value in payloads.items()}
        reference_model = _build_reference_model(
            contract=contract, source_fd=source_fd, hidden_size=hidden_size, rows=rows
        )
        tiled_model = _build_tiled_model(
            contract=contract,
            payload_fds=payload_fds,
            execution_tiles=tiles,
            source_fd=source_fd,
            hidden_size=hidden_size,
            rows=rows,
        )
        feeds = _inputs(hidden_size)
        reference_logits, reference_norm, reference_timing = _run_model(reference_model, feeds)
        tiled_logits, tiled_norm, tiled_timing = _run_model(tiled_model, feeds)
        norm_comparison = _comparison(tiled_norm, reference_norm)
        logits_comparison = _comparison(tiled_logits, reference_logits)
        if not norm_comparison["allClose"]:
            raise RuntimeError(
                "tiled post-stage final-norm output diverged from source-poststage reference"
            )
        if not logits_comparison["allClose"]:
            raise RuntimeError(
                "tiled post-stage logits diverged from source-poststage reference: "
                f"max abs diff={logits_comparison['maxAbsDiff']}, "
                f"max relative diff={logits_comparison['maxRelativeDiff']}"
            )

        tile_comparisons: list[dict[str, object]] = []
        for tile in tiles:
            start = int(tile["startRow"])
            end = int(tile["endRowExclusive"])
            comparison = _comparison(tiled_logits[..., start:end], reference_logits[..., start:end])
            comparison.update({"tileIndex": tile["tileIndex"], "startRow": start, "endRowExclusive": end})
            tile_comparisons.append(comparison)

        if source_model_path_identity is None:
            raise RuntimeError("source graph identity was not pinned")
        preferred_probe._assert_payload_path_identity(
            source_model_path, pinned_identity=source_model_path_identity
        )
        preferred_probe._assert_payload_path_identity(
            source_external_data, pinned_identity=source_path_identity
        )
        for _, path, identity in payloads.values():
            preferred_probe._assert_payload_path_identity(path, pinned_identity=identity)

        return {
            "schemaVersion": REPORT_SCHEMA_VERSION,
            "kind": REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "upstreamProbe": {
                "kind": layout.get("kind"),
                "schemaVersion": layout.get("schemaVersion"),
            },
            "sourceGraphSha256": source_graph_sha256,
            "verifiedPinnedSourceGraph": verified_source_graph,
            "pinnedSourceExternalDataIdentity": source_identity,
            "verifiedPinnedSourceExternalData": verified_source,
            "postStageContract": contract,
            "finalNormWeightSha256": norm_sha256,
            "physicalArtifactCount": PHYSICAL_ARTIFACT_COUNT,
            "executionTileCount": EXECUTION_TILE_COUNT,
            "verifiedPhysicalPayloads": verified_payloads,
            "inputShape": [1, 1, hidden_size],
            "reference": {
                "kind": "source-poststage-topology-with-full-tied-weight",
                **reference_timing,
            },
            "staged": {
                "kind": "single-final-norm-plus-eight-vocabulary-row-logits-tiles",
                **tiled_timing,
            },
            "finalNormComparison": norm_comparison,
            "logitsComparison": logits_comparison,
            "perExecutionTileLogitsComparison": tile_comparisons,
            "onnxruntime": {"version": ort.__version__, "provider": "CPUExecutionProvider"},
            "environment": {
                "pythonVersion": platform.python_version(),
                "numpyVersion": np.__version__,
                "onnxVersion": onnx.__version__,
                "system": platform.system(),
                "release": platform.release(),
                "machine": platform.machine(),
                "macOSVersion": platform.mac_ver()[0] or None,
            },
            "conclusion": (
                "The pinned source final-norm + full tied-weight lm_head reference and an "
                "8-way vocabulary-row logits composition backed by four independently "
                "verified preferred physical payloads produced numerically equivalent "
                "complete logits under pinned onnxruntime CPU. This closes only the "
                "post-stage composition S0 question; it does not select this layout, prove "
                "full-model multi-segment equivalence, exercise browser/WebGPU execution, "
                "measure working set or reclamation, or define production runtime semantics."
            ),
        }
    finally:
        if reference_model is not None:
            reference_model.unlink(missing_ok=True)
        if tiled_model is not None:
            tiled_model.unlink(missing_ok=True)
        for fd, _, _ in payloads.values():
            try:
                os.close(fd)
            except OSError:
                pass
        if source_fd >= 0:
            try:
                os.close(source_fd)
            except OSError:
                pass
        if source_model_fd >= 0:
            try:
                os.close(source_model_fd)
            except OSError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path)
    parser.add_argument("source_external_data", type=Path)
    parser.add_argument("payload_root", type=Path)
    args = parser.parse_args()
    print(
        json.dumps(
            build_report(args.source_model, args.source_external_data, args.payload_root),
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
