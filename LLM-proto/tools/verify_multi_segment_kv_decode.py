#!/usr/bin/env python3
"""Verify prompt + one cached decode step across a budgeted multi-segment ONNX model.

This is a same-machine CPU/ORT correctness gate for #167/#346. It extends the
single-step multi-segment verifier by preserving each decoder segment's own KV
cache between a prompt prefill and one subsequent token. KV tensors are never
relayed between segments: the Coordinator-facing relay remains only the hidden
state boundary recorded in the split manifest.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import re
from pathlib import Path
from typing import Mapping, Sequence

import numpy as np
import onnxruntime as ort

from verify_multi_segment_artifacts import verify_artifact_integrity
from verify_multi_segment_onnx import (
    _boundary_report,
    validate_multi_segment_manifest,
    verify_source_model_identity,
)
from verify_split_onnx import _last_token_argmax, build_feeds, compare_logits, parse_token_ids


PRESENT_RE = re.compile(r"^present\.(\d+)\.(key|value)$")
PAST_RE = re.compile(r"^past_key_values\.(\d+)\.(key|value)$")


def _cache_key(name: str, *, present: bool) -> tuple[int, str]:
    match = (PRESENT_RE if present else PAST_RE).fullmatch(name)
    if match is None:
        kind = "present" if present else "past_key_values"
        raise ValueError(f"unsupported {kind} cache tensor name: {name}")
    return int(match.group(1)), match.group(2)


def _present_to_past(name: str) -> str:
    layer, kind = _cache_key(name, present=True)
    return f"past_key_values.{layer}.{kind}"


def _cache_names(node_args: Sequence[ort.NodeArg], *, present: bool) -> tuple[str, ...]:
    regex = PRESENT_RE if present else PAST_RE
    names = tuple(arg.name for arg in node_args if regex.fullmatch(arg.name))
    keys = [_cache_key(name, present=present) for name in names]
    if len(set(keys)) != len(keys):
        raise ValueError("duplicate KV cache tensor identity")
    return tuple(name for _, name in sorted(zip(keys, names, strict=True)))


def _validate_cache_pairs(names: Sequence[str], *, present: bool, expected_layers: range) -> None:
    observed: dict[int, set[str]] = {}
    for name in names:
        layer, kind = _cache_key(name, present=present)
        observed.setdefault(layer, set()).add(kind)
    expected = {layer: {"key", "value"} for layer in expected_layers}
    if observed != expected:
        kind = "present" if present else "past"
        raise ValueError(f"{kind} KV cache ownership mismatch: expected={expected}, observed={observed}")


def _build_cached_feeds(
    session: ort.InferenceSession,
    token_ids: Sequence[int],
    *,
    boundary: Mapping[str, np.ndarray] | None,
    past_cache: Mapping[str, np.ndarray] | None,
    past_length: int,
    kv_heads: int,
    head_size: int,
) -> dict[str, np.ndarray]:
    if past_length < 0:
        raise ValueError("past_length must be non-negative")
    feeds = build_feeds(
        session,
        token_ids,
        boundary=dict(boundary or {}),
        kv_heads=kv_heads,
        head_size=head_size,
    )
    required_past = _cache_names(session.get_inputs(), present=False)
    supplied = dict(past_cache or {})
    if past_length > 0:
        missing = [name for name in required_past if name not in supplied]
        extra = sorted(set(supplied) - set(required_past))
        if missing or extra:
            raise ValueError(
                f"cached decode requires exact segment-local KV inputs: missing={missing}, extra={extra}"
            )
        for name in required_past:
            feeds[name] = supplied[name]

    total_context = past_length + len(token_ids)
    for node_arg in session.get_inputs():
        name = node_arg.name
        if "attention_mask" in name:
            feeds[name] = np.ones((1, total_context), dtype=feeds[name].dtype)
        elif "position_ids" in name:
            feeds[name] = np.asarray(
                list(range(past_length, past_length + len(token_ids))),
                dtype=feeds[name].dtype,
            ).reshape(1, len(token_ids))
    return feeds


def _tensor_map_comparison(
    reference: Mapping[str, np.ndarray],
    candidate: Mapping[str, np.ndarray],
    *,
    atol: float,
    rtol: float,
) -> dict[str, object]:
    reference_names = set(reference)
    candidate_names = set(candidate)
    if reference_names != candidate_names:
        raise ValueError(
            "KV output name mismatch: "
            f"missing={sorted(reference_names - candidate_names)}, "
            f"extra={sorted(candidate_names - reference_names)}"
        )
    tensors: list[dict[str, object]] = []
    all_match = True
    total_bytes = 0
    for name in sorted(reference_names, key=lambda item: _cache_key(item, present=True)):
        expected = reference[name]
        actual = candidate[name]
        shape_match = expected.shape == actual.shape
        if shape_match:
            diff = np.abs(expected.astype(np.float64) - actual.astype(np.float64))
            max_abs = float(diff.max(initial=0.0))
            matches = bool(np.allclose(expected, actual, atol=atol, rtol=rtol))
        else:
            max_abs = None
            matches = False
        all_match = all_match and matches
        total_bytes += int(actual.nbytes)
        tensors.append(
            {
                "name": name,
                "shape": list(actual.shape),
                "dtype": str(actual.dtype),
                "bytes": int(actual.nbytes),
                "shapeMatch": shape_match,
                "matches": matches,
                "maxAbsDiff": max_abs,
            }
        )
    return {
        "matches": all_match,
        "tensorCount": len(tensors),
        "bytes": total_bytes,
        "tensors": tensors,
    }


def _run_full_step(
    session: ort.InferenceSession,
    *,
    token_ids: Sequence[int],
    logits_name: str,
    past_cache: Mapping[str, np.ndarray] | None,
    past_length: int,
    kv_heads: int,
    head_size: int,
) -> tuple[np.ndarray, dict[str, np.ndarray], int]:
    present_names = _cache_names(session.get_outputs(), present=True)
    input_cache_names = _cache_names(session.get_inputs(), present=False)
    present_keys = {_cache_key(name, present=True) for name in present_names}
    past_keys = {_cache_key(name, present=False) for name in input_cache_names}
    if present_keys != past_keys:
        raise ValueError(
            f"full-model KV input/output contract mismatch: inputs={sorted(past_keys)}, outputs={sorted(present_keys)}"
        )
    feeds = _build_cached_feeds(
        session,
        token_ids,
        boundary=None,
        past_cache=past_cache,
        past_length=past_length,
        kv_heads=kv_heads,
        head_size=head_size,
    )
    values = session.run([logits_name, *present_names], feeds)
    cache = dict(zip(present_names, values[1:], strict=True))
    consumed = sum(int(feeds[name].nbytes) for name in input_cache_names) if past_length > 0 else 0
    return values[0], cache, consumed


def _run_split_step(
    segments: Sequence[dict[str, object]],
    boundaries: Sequence[dict[str, object]],
    *,
    token_ids: Sequence[int],
    logits_name: str,
    prior_present: Mapping[str, np.ndarray] | None,
    past_length: int,
    provider: str,
    kv_heads: int,
    head_size: int,
) -> tuple[np.ndarray, dict[str, np.ndarray], list[dict[str, object]], int]:
    boundary_values: dict[str, np.ndarray] = {}
    present_values: dict[str, np.ndarray] = {}
    boundary_reports: list[dict[str, object]] = []
    consumed_cache_bytes = 0
    split_logits: np.ndarray | None = None

    for index, segment in enumerate(segments):
        session = ort.InferenceSession(str(segment["path"]), providers=[provider])
        start = int(segment["startLayer"])
        end = int(segment["endLayer"])
        present_names = _cache_names(session.get_outputs(), present=True)
        past_names = _cache_names(session.get_inputs(), present=False)
        _validate_cache_pairs(present_names, present=True, expected_layers=range(start, end))
        _validate_cache_pairs(past_names, present=False, expected_layers=range(start, end))
        expected_past_names = {_present_to_past(name) for name in present_names}
        if set(past_names) != expected_past_names:
            raise ValueError(
                f"segment {index} present/past mapping mismatch: past={sorted(past_names)}, expected={sorted(expected_past_names)}"
            )

        segment_past: dict[str, np.ndarray] | None = None
        if past_length > 0:
            if prior_present is None:
                raise ValueError("cached decode requires prompt KV outputs")
            segment_past = {}
            for past_name in past_names:
                layer, kind = _cache_key(past_name, present=False)
                present_name = f"present.{layer}.{kind}"
                if present_name not in prior_present:
                    raise ValueError(f"missing prompt KV output for {past_name}")
                segment_past[past_name] = prior_present[present_name]

        feeds = _build_cached_feeds(
            session,
            token_ids,
            boundary=boundary_values,
            past_cache=segment_past,
            past_length=past_length,
            kv_heads=kv_heads,
            head_size=head_size,
        )
        if past_length > 0:
            consumed_cache_bytes += sum(int(feeds[name].nbytes) for name in past_names)

        if index < len(boundaries):
            boundary = boundaries[index]
            names = tuple(boundary["names"])
            requested = [*names, *present_names]
            values = session.run(requested, feeds)
            boundary_count = len(names)
            boundary_arrays = values[:boundary_count]
            boundary_values = dict(zip(names, boundary_arrays, strict=True))
            boundary_reports.append(
                _boundary_report(
                    after_layer=int(boundary["afterLayer"]),
                    before_layer=int(boundary["beforeLayer"]),
                    names=names,
                    values=boundary_arrays,
                )
            )
            present_arrays = values[boundary_count:]
        else:
            values = session.run([logits_name, *present_names], feeds)
            split_logits = values[0]
            present_arrays = values[1:]
        for name, value in zip(present_names, present_arrays, strict=True):
            if name in present_values:
                raise ValueError(f"duplicate split KV output: {name}")
            present_values[name] = value
        del feeds
        del session
        gc.collect()

    if split_logits is None:
        raise AssertionError("final segment did not produce logits")
    return split_logits, present_values, boundary_reports, consumed_cache_bytes


def verify_multi_segment_kv_decode(
    full_model_path: Path,
    manifest_path: Path,
    prompt_token_ids: Sequence[int],
    next_token_id: int,
    *,
    provider: str = "CPUExecutionProvider",
    kv_heads: int = 8,
    head_size: int = 64,
    atol: float = 1e-4,
    rtol: float = 1e-4,
) -> dict[str, object]:
    if not prompt_token_ids:
        raise ValueError("at least one prompt token ID is required")
    if next_token_id < 0:
        raise ValueError("next_token_id must be non-negative")

    artifact_integrity = verify_artifact_integrity(manifest_path)
    manifest_bytes = manifest_path.read_bytes()
    observed_manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    if observed_manifest_sha != artifact_integrity["manifestSha256"]:
        raise RuntimeError("split manifest changed after artifact-integrity preflight")
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("split manifest must contain a JSON object")
    source_identity = verify_source_model_identity(full_model_path, manifest)
    contract = validate_multi_segment_manifest(manifest, manifest_path.parent)
    segments = contract["segments"]
    boundaries = contract["boundaries"]
    logits_name = str(contract["logitsOutput"])

    full_session = ort.InferenceSession(str(full_model_path), providers=[provider])
    full_prompt_logits, full_prompt_present, _ = _run_full_step(
        full_session,
        token_ids=prompt_token_ids,
        logits_name=logits_name,
        past_cache=None,
        past_length=0,
        kv_heads=kv_heads,
        head_size=head_size,
    )
    full_decode_past = {_present_to_past(name): value for name, value in full_prompt_present.items()}
    full_decode_logits, full_decode_present, full_consumed = _run_full_step(
        full_session,
        token_ids=[next_token_id],
        logits_name=logits_name,
        past_cache=full_decode_past,
        past_length=len(prompt_token_ids),
        kv_heads=kv_heads,
        head_size=head_size,
    )
    del full_session
    gc.collect()

    split_prompt_logits, split_prompt_present, prompt_boundaries, _ = _run_split_step(
        segments,
        boundaries,
        token_ids=prompt_token_ids,
        logits_name=logits_name,
        prior_present=None,
        past_length=0,
        provider=provider,
        kv_heads=kv_heads,
        head_size=head_size,
    )
    split_decode_logits, split_decode_present, decode_boundaries, split_consumed = _run_split_step(
        segments,
        boundaries,
        token_ids=[next_token_id],
        logits_name=logits_name,
        prior_present=split_prompt_present,
        past_length=len(prompt_token_ids),
        provider=provider,
        kv_heads=kv_heads,
        head_size=head_size,
    )

    prompt_logits_comparison = compare_logits(full_prompt_logits, split_prompt_logits, atol, rtol)
    decode_logits_comparison = compare_logits(full_decode_logits, split_decode_logits, atol, rtol)
    prompt_kv_comparison = _tensor_map_comparison(
        full_prompt_present, split_prompt_present, atol=atol, rtol=rtol
    )
    decode_kv_comparison = _tensor_map_comparison(
        full_decode_present, split_decode_present, atol=atol, rtol=rtol
    )
    full_prompt_top1 = _last_token_argmax(full_prompt_logits)
    split_prompt_top1 = _last_token_argmax(split_prompt_logits)
    full_decode_top1 = _last_token_argmax(full_decode_logits)
    split_decode_top1 = _last_token_argmax(split_decode_logits)

    status = "pass" if all(
        [
            prompt_logits_comparison["matches"],
            decode_logits_comparison["matches"],
            prompt_kv_comparison["matches"],
            decode_kv_comparison["matches"],
            full_prompt_top1 == split_prompt_top1,
            full_decode_top1 == split_decode_top1,
            full_consumed > 0,
            split_consumed > 0,
        ]
    ) else "fail"

    return {
        "schemaVersion": "1.0.0",
        "kind": "unzen-budgeted-multi-segment-kv-decode-verification",
        "decisionStatus": "diagnostic-only",
        "provider": provider,
        "promptTokenIds": list(prompt_token_ids),
        "nextTokenId": next_token_id,
        "segmentCount": len(segments),
        "cutLayers": [int(segment["endLayer"]) for segment in segments[:-1]],
        "artifactIntegrity": artifact_integrity,
        "sourceModel": source_identity,
        "kvCacheOwnership": "segment-local",
        "coordinatorRelaysKvCache": False,
        "prompt": {
            "logitsComparison": prompt_logits_comparison,
            "kvComparison": prompt_kv_comparison,
            "boundaries": prompt_boundaries,
            "boundaryBytes": sum(int(item["bytes"]) for item in prompt_boundaries),
            "fullTop1TokenId": full_prompt_top1,
            "splitTop1TokenId": split_prompt_top1,
        },
        "decode": {
            "logitsComparison": decode_logits_comparison,
            "kvComparison": decode_kv_comparison,
            "boundaries": decode_boundaries,
            "boundaryBytes": sum(int(item["bytes"]) for item in decode_boundaries),
            "fullPastCacheBytesConsumed": full_consumed,
            "splitPastCacheBytesConsumed": split_consumed,
            "fullTop1TokenId": full_decode_top1,
            "splitTop1TokenId": split_decode_top1,
        },
        "sequentialSegmentSessionLoading": True,
        "status": status,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full-model", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--input-ids", required=True, help="Comma-separated prompt token IDs")
    parser.add_argument("--next-token-id", type=int, required=True)
    parser.add_argument("--provider", default="CPUExecutionProvider")
    parser.add_argument("--kv-heads", type=int, default=8)
    parser.add_argument("--head-size", type=int, default=64)
    parser.add_argument("--atol", type=float, default=1e-4)
    parser.add_argument("--rtol", type=float, default=1e-4)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = verify_multi_segment_kv_decode(
        args.full_model,
        args.manifest,
        parse_token_ids(args.input_ids),
        args.next_token_id,
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
