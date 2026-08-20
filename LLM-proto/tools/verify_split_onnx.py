#!/usr/bin/env python3
"""Run a full ONNX model and its two Unzen segments with identical token IDs.

This is the same-machine correctness gate for issue #165. It accepts token IDs
rather than adding a tokenizer dependency: the browser harness reports the exact
IDs it used, and this verifier reuses those IDs to compare full-model logits
against segment0 -> boundary -> segment1.

Sessions are created and released sequentially so the real 1.7 GB q4 source
model and both split segments are not resident at the same time.
"""

from __future__ import annotations

import argparse
import gc
import json
from pathlib import Path
from typing import Sequence

import numpy as np
import onnxruntime as ort


def _np_dtype(type_name: str) -> np.dtype:
    mapping = {
        "tensor(float)": np.dtype(np.float32),
        "tensor(float16)": np.dtype(np.float16),
        "tensor(double)": np.dtype(np.float64),
        "tensor(int64)": np.dtype(np.int64),
        "tensor(int32)": np.dtype(np.int32),
        "tensor(int16)": np.dtype(np.int16),
        "tensor(int8)": np.dtype(np.int8),
        "tensor(uint64)": np.dtype(np.uint64),
        "tensor(uint32)": np.dtype(np.uint32),
        "tensor(uint16)": np.dtype(np.uint16),
        "tensor(uint8)": np.dtype(np.uint8),
        "tensor(bool)": np.dtype(np.bool_),
    }
    if type_name not in mapping:
        raise ValueError(f"unsupported ONNX Runtime input type: {type_name}")
    return mapping[type_name]


def _resolve_symbolic_dimension(
    value: object,
    *,
    input_name: str,
    index: int,
    sequence_length: int,
    kv_heads: int,
    head_size: int,
) -> int:
    if isinstance(value, int):
        return value
    text = str(value or "").lower()
    if "batch" in text:
        return 1
    if "num_key_value_heads" in text:
        return kv_heads
    if "head_size" in text or "head_dim" in text:
        return head_size
    if "past" in text:
        return 0
    if "head" in text and "size" not in text:
        return kv_heads
    if "sequence" in text or "seq" in text:
        if "past_key_values" in input_name or "past" in input_name:
            return 0
        return sequence_length
    if "past_key_values" in input_name or "past" in input_name:
        fallback = (1, kv_heads, 0, head_size)
        if index < len(fallback):
            return fallback[index]
    raise ValueError(
        f"cannot resolve symbolic dimension {value!r} for {input_name} axis {index}; "
        "pass a graph with concrete cache head dimensions or adjust --kv-heads/--head-size"
    )


def _empty_cache_value(
    node_arg: ort.NodeArg,
    *,
    sequence_length: int,
    kv_heads: int,
    head_size: int,
) -> np.ndarray:
    dtype = _np_dtype(node_arg.type)
    shape = tuple(
        _resolve_symbolic_dimension(
            value,
            input_name=node_arg.name,
            index=index,
            sequence_length=sequence_length,
            kv_heads=kv_heads,
            head_size=head_size,
        )
        for index, value in enumerate(node_arg.shape or [])
    )
    return np.zeros(shape, dtype=dtype)


def _integer_value(node_arg: ort.NodeArg, values: Sequence[int], shape: tuple[int, ...]) -> np.ndarray:
    dtype = _np_dtype(node_arg.type)
    if dtype.kind not in ("i", "u"):
        raise ValueError(f"expected integer input for {node_arg.name}, got {node_arg.type}")
    return np.asarray(values, dtype=dtype).reshape(shape)


def build_feeds(
    session: ort.InferenceSession,
    token_ids: Sequence[int],
    *,
    boundary: dict[str, np.ndarray] | None = None,
    kv_heads: int = 8,
    head_size: int = 64,
) -> dict[str, np.ndarray]:
    sequence_length = len(token_ids)
    feeds: dict[str, np.ndarray] = {}
    boundary = boundary or {}
    for node_arg in session.get_inputs():
        name = node_arg.name
        if name in boundary:
            feeds[name] = boundary[name]
        elif name == "input_ids" or name.endswith("/input_ids"):
            feeds[name] = _integer_value(node_arg, token_ids, (1, sequence_length))
        elif "attention_mask" in name:
            feeds[name] = _integer_value(node_arg, [1] * sequence_length, (1, sequence_length))
        elif "position_ids" in name:
            feeds[name] = _integer_value(node_arg, list(range(sequence_length)), (1, sequence_length))
        elif "past_key_values" in name or name.startswith("past.") or "/past" in name:
            feeds[name] = _empty_cache_value(
                node_arg,
                sequence_length=sequence_length,
                kv_heads=kv_heads,
                head_size=head_size,
            )
        else:
            raise ValueError(f"no feed builder for model input: {name} ({node_arg.type}, {node_arg.shape})")
    return feeds


def compare_logits(full_logits: np.ndarray, split_logits: np.ndarray, atol: float, rtol: float) -> dict[str, object]:
    if full_logits.shape != split_logits.shape:
        return {
            "matches": False,
            "shapeMatch": False,
            "fullShape": list(full_logits.shape),
            "splitShape": list(split_logits.shape),
            "maxAbsDiff": None,
        }
    diff = np.abs(full_logits.astype(np.float64) - split_logits.astype(np.float64))
    max_abs = float(diff.max(initial=0.0))
    matches = bool(np.allclose(full_logits, split_logits, atol=atol, rtol=rtol))
    return {
        "matches": matches,
        "shapeMatch": True,
        "fullShape": list(full_logits.shape),
        "splitShape": list(split_logits.shape),
        "maxAbsDiff": max_abs,
    }


def _last_token_argmax(logits: np.ndarray) -> int:
    if logits.ndim != 3 or logits.shape[0] != 1:
        raise ValueError(f"expected logits [1, seq, vocab], got {logits.shape}")
    return int(np.argmax(logits[0, -1]))


def _release_session(session: ort.InferenceSession) -> None:
    del session
    gc.collect()


def verify_split(
    full_model_path: Path,
    segment0_path: Path,
    segment1_path: Path,
    manifest_path: Path,
    token_ids: Sequence[int],
    *,
    provider: str = "CPUExecutionProvider",
    kv_heads: int = 8,
    head_size: int = 64,
    atol: float = 1e-4,
    rtol: float = 1e-4,
) -> dict[str, object]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    boundary_names = [item["name"] for item in manifest["boundary"]["tensors"]]
    logits_name = manifest["logitsOutput"]
    providers = [provider]

    full_session = ort.InferenceSession(str(full_model_path), providers=providers)
    full_feeds = build_feeds(full_session, token_ids, kv_heads=kv_heads, head_size=head_size)
    full_logits = full_session.run([logits_name], full_feeds)[0]
    del full_feeds
    _release_session(full_session)

    segment0_session = ort.InferenceSession(str(segment0_path), providers=providers)
    segment0_feeds = build_feeds(segment0_session, token_ids, kv_heads=kv_heads, head_size=head_size)
    boundary_values = segment0_session.run(boundary_names, segment0_feeds)
    boundary = dict(zip(boundary_names, boundary_values, strict=True))
    del segment0_feeds
    _release_session(segment0_session)

    segment1_session = ort.InferenceSession(str(segment1_path), providers=providers)
    segment1_feeds = build_feeds(
        segment1_session,
        token_ids,
        boundary=boundary,
        kv_heads=kv_heads,
        head_size=head_size,
    )
    split_logits = segment1_session.run([logits_name], segment1_feeds)[0]
    del segment1_feeds
    _release_session(segment1_session)

    comparison = compare_logits(full_logits, split_logits, atol, rtol)
    report: dict[str, object] = {
        "schemaVersion": "1.0.0",
        "kind": "unzen-real-two-segment-same-machine-verification",
        "provider": provider,
        "inputTokenIds": list(token_ids),
        "boundary": [
            {
                "name": name,
                "shape": list(value.shape),
                "dtype": str(value.dtype),
                "bytes": int(value.nbytes),
            }
            for name, value in boundary.items()
        ],
        "boundaryBytes": int(sum(value.nbytes for value in boundary.values())),
        "comparison": comparison,
        "fullTop1TokenId": _last_token_argmax(full_logits),
        "splitTop1TokenId": _last_token_argmax(split_logits),
        "sequentialSessionLoading": True,
    }
    report["status"] = (
        "pass"
        if comparison["matches"] and report["fullTop1TokenId"] == report["splitTop1TokenId"]
        else "fail"
    )
    return report


def parse_token_ids(raw: str) -> list[int]:
    values = [piece.strip() for piece in raw.split(",") if piece.strip()]
    if not values:
        raise ValueError("at least one token ID is required")
    return [int(value) for value in values]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full-model", type=Path, required=True)
    parser.add_argument("--segment0", type=Path, required=True)
    parser.add_argument("--segment1", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--input-ids", required=True, help="Comma-separated token IDs copied from the browser harness")
    parser.add_argument("--provider", default="CPUExecutionProvider")
    parser.add_argument("--kv-heads", type=int, default=8)
    parser.add_argument("--head-size", type=int, default=64)
    parser.add_argument("--atol", type=float, default=1e-4)
    parser.add_argument("--rtol", type=float, default=1e-4)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = verify_split(
        args.full_model,
        args.segment0,
        args.segment1,
        args.manifest,
        parse_token_ids(args.input_ids),
        provider=args.provider,
        kv_heads=args.kv_heads,
        head_size=args.head_size,
        atol=args.atol,
        rtol=args.rtol,
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
