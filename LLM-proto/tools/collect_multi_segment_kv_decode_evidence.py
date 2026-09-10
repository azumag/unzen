#!/usr/bin/env python3
"""Collect provenance-rich #167 prompt + cached-decode evidence.

This wrapper persists the diagnostic-only report produced by
``verify_multi_segment_kv_decode.py`` together with the exact run parameters and
runtime metadata needed to reproduce a real 1B q4 capture. It deliberately
revalidates the verifier result before publication so a future verifier refactor
cannot silently drop the artifact/source identity, KV ownership, comparison, or
relay-accounting fields on which the evidence claim depends.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import re
from typing import Sequence

import numpy as np
import onnxruntime as ort

from collect_multi_segment_evidence import (
    _canonical_sha256,
    _finite_non_negative_float,
    _non_negative_int,
    _positive_int,
    _shape,
    _validate_artifact_integrity,
    _validate_boundaries,
    canonical_json_bytes,
    ensure_output_available,
    ensure_provider_available,
    validate_run_parameters as validate_base_run_parameters,
    write_evidence,
)
from verify_multi_segment_kv_decode import verify_multi_segment_kv_decode
from verify_split_onnx import parse_token_ids


EVIDENCE_KIND = "unzen-budgeted-multi-segment-kv-decode-evidence-bundle"
EVIDENCE_SCHEMA_VERSION = "1.0.0"
VERIFICATION_KIND = "unzen-budgeted-multi-segment-kv-decode-verification"
VERIFICATION_SCHEMA_VERSION = "1.0.0"
PRESENT_RE = re.compile(r"^present\.(\d+)\.(key|value)$")


def validate_run_parameters(
    prompt_token_ids: Sequence[int],
    next_token_id: int,
    *,
    kv_heads: int,
    head_size: int,
    atol: float,
    rtol: float,
) -> tuple[list[int], int, int, int, float, float]:
    """Reject malformed run parameters before provider/model work."""

    prompt, kv_heads, head_size, atol, rtol = validate_base_run_parameters(
        prompt_token_ids,
        kv_heads=kv_heads,
        head_size=head_size,
        atol=atol,
        rtol=rtol,
    )
    next_token = _non_negative_int(next_token_id, field="nextTokenId")
    return prompt, next_token, kv_heads, head_size, atol, rtol


def _normalize_created_at(created_at: datetime | None) -> str:
    timestamp = created_at or datetime.now(timezone.utc)
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError("created_at must be timezone-aware")
    return timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_source_model(raw: object) -> None:
    if not isinstance(raw, dict):
        raise ValueError("cached-decode verifier sourceModel must be an object")
    path = raw.get("path")
    if not isinstance(path, str) or not path:
        raise ValueError("cached-decode verifier sourceModel.path must be a non-empty string")
    _non_negative_int(raw.get("graphBytes"), field="verification.sourceModel.graphBytes")
    _canonical_sha256(raw.get("graphSha256"), field="verification.sourceModel.graphSha256")
    if raw.get("allExternalDataHashed") is not True:
        raise ValueError("cached-decode verifier sourceModel must hash all external data")
    external = raw.get("externalData")
    if not isinstance(external, list):
        raise ValueError("cached-decode verifier sourceModel.externalData must be an array")
    seen: set[str] = set()
    for index, entry in enumerate(external):
        if not isinstance(entry, dict):
            raise ValueError(f"verification.sourceModel.externalData[{index}] must be an object")
        prefix = f"verification.sourceModel.externalData[{index}]"
        location = entry.get("location")
        if not isinstance(location, str) or not location or location in seen:
            raise ValueError(f"{prefix}.location must be a non-empty unique string")
        seen.add(location)
        _non_negative_int(entry.get("bytes"), field=f"{prefix}.bytes")
        _canonical_sha256(entry.get("sha256"), field=f"{prefix}.sha256")


def _validate_logits_comparison(raw: object, *, field: str) -> bool:
    if not isinstance(raw, dict):
        raise ValueError(f"{field} must be an object")
    matches = raw.get("matches")
    shape_match = raw.get("shapeMatch")
    if not isinstance(matches, bool) or not isinstance(shape_match, bool):
        raise ValueError(f"{field}.matches/shapeMatch must be boolean")
    full_shape = _shape(raw.get("fullShape"), field=f"{field}.fullShape")
    split_shape = _shape(raw.get("splitShape"), field=f"{field}.splitShape")
    if shape_match != (full_shape == split_shape):
        raise ValueError(f"{field}.shapeMatch contradicts reported shapes")
    max_abs = raw.get("maxAbsDiff")
    if shape_match:
        _finite_non_negative_float(max_abs, field=f"{field}.maxAbsDiff")
    elif max_abs is not None:
        raise ValueError(f"{field}.maxAbsDiff must be null on shape mismatch")
    if matches and not shape_match:
        raise ValueError(f"{field}.matches cannot pass on shape mismatch")
    return matches


def _validate_kv_comparison(raw: object, *, field: str) -> tuple[bool, tuple[str, ...]]:
    if not isinstance(raw, dict):
        raise ValueError(f"{field} must be an object")
    matches = raw.get("matches")
    if not isinstance(matches, bool):
        raise ValueError(f"{field}.matches must be boolean")
    tensor_count = _non_negative_int(raw.get("tensorCount"), field=f"{field}.tensorCount")
    reported_bytes = _non_negative_int(raw.get("bytes"), field=f"{field}.bytes")
    tensors = raw.get("tensors")
    if not isinstance(tensors, list) or len(tensors) != tensor_count:
        raise ValueError(f"{field}.tensors must match tensorCount")

    observed_bytes = 0
    identities: dict[int, set[str]] = {}
    seen_identities: set[tuple[int, str]] = set()
    names: list[str] = []
    all_tensor_matches = True
    for index, tensor in enumerate(tensors):
        if not isinstance(tensor, dict):
            raise ValueError(f"{field}.tensors[{index}] must be an object")
        prefix = f"{field}.tensors[{index}]"
        name = tensor.get("name")
        if not isinstance(name, str):
            raise ValueError(f"{prefix}.name must be a string")
        match = PRESENT_RE.fullmatch(name)
        if match is None:
            raise ValueError(f"{prefix}.name must be present.<layer>.<key|value>")
        layer = int(match.group(1))
        kind = match.group(2)
        identity = (layer, kind)
        if name != f"present.{layer}.{kind}" or identity in seen_identities:
            raise ValueError(f"{prefix}.name must encode a unique canonical KV identity")
        seen_identities.add(identity)
        identities.setdefault(layer, set()).add(kind)
        names.append(name)
        _shape(tensor.get("shape"), field=f"{prefix}.shape")
        dtype = tensor.get("dtype")
        if not isinstance(dtype, str) or not dtype:
            raise ValueError(f"{prefix}.dtype must be a non-empty string")
        observed_bytes += _non_negative_int(tensor.get("bytes"), field=f"{prefix}.bytes")
        shape_match = tensor.get("shapeMatch")
        tensor_matches = tensor.get("matches")
        if not isinstance(shape_match, bool) or not isinstance(tensor_matches, bool):
            raise ValueError(f"{prefix}.shapeMatch/matches must be boolean")
        max_abs = tensor.get("maxAbsDiff")
        if shape_match:
            _finite_non_negative_float(max_abs, field=f"{prefix}.maxAbsDiff")
        elif max_abs is not None:
            raise ValueError(f"{prefix}.maxAbsDiff must be null on shape mismatch")
        if tensor_matches and not shape_match:
            raise ValueError(f"{prefix}.matches cannot pass on shape mismatch")
        all_tensor_matches = all_tensor_matches and tensor_matches

    incomplete = {layer: kinds for layer, kinds in identities.items() if kinds != {"key", "value"}}
    if incomplete:
        raise ValueError(f"{field} contains incomplete key/value layer pairs: {incomplete}")
    layers = sorted(identities)
    if layers and layers != list(range(layers[-1] + 1)):
        raise ValueError(f"{field} KV layer identities must be contiguous from layer 0")
    if observed_bytes != reported_bytes:
        raise ValueError(f"{field}.bytes does not match tensor byte sum")
    if matches != all_tensor_matches:
        raise ValueError(f"{field}.matches contradicts per-tensor matches")
    return matches, tuple(sorted(names))


def _boundary_signature(raw: object, *, field: str) -> tuple[tuple[int, int, tuple[str, ...]], ...]:
    if not isinstance(raw, list):
        raise ValueError(f"{field} must be an array")
    result: list[tuple[int, int, tuple[str, ...]]] = []
    for index, boundary in enumerate(raw):
        if not isinstance(boundary, dict):
            raise ValueError(f"{field}[{index}] must be an object")
        after = _non_negative_int(boundary.get("afterLayer"), field=f"{field}[{index}].afterLayer")
        before = _non_negative_int(boundary.get("beforeLayer"), field=f"{field}[{index}].beforeLayer")
        tensors = boundary.get("tensors")
        if not isinstance(tensors, list):
            raise ValueError(f"{field}[{index}].tensors must be an array")
        names: list[str] = []
        for tensor_index, tensor in enumerate(tensors):
            if not isinstance(tensor, dict):
                raise ValueError(f"{field}[{index}].tensors[{tensor_index}] must be an object")
            name = tensor.get("name")
            if not isinstance(name, str) or not name:
                raise ValueError(f"{field}[{index}].tensors[{tensor_index}].name must be a non-empty string")
            names.append(name)
        result.append((after, before, tuple(names)))
    return tuple(result)


def _validate_step(
    raw: object,
    *,
    field: str,
    segment_count: int,
) -> tuple[
    bool,
    bool,
    int,
    int,
    tuple[str, ...],
    tuple[tuple[int, int, tuple[str, ...]], ...],
]:
    if not isinstance(raw, dict):
        raise ValueError(f"{field} must be an object")
    boundaries = raw.get("boundaries")
    _validate_boundaries(
        {"boundaries": boundaries, "boundaryBytes": raw.get("boundaryBytes")},
        segment_count=segment_count,
    )
    signature = _boundary_signature(boundaries, field=f"{field}.boundaries")
    logits_match = _validate_logits_comparison(
        raw.get("logitsComparison"), field=f"{field}.logitsComparison"
    )
    kv_match, kv_names = _validate_kv_comparison(
        raw.get("kvComparison"), field=f"{field}.kvComparison"
    )
    full_top1 = _non_negative_int(raw.get("fullTop1TokenId"), field=f"{field}.fullTop1TokenId")
    split_top1 = _non_negative_int(raw.get("splitTop1TokenId"), field=f"{field}.splitTop1TokenId")
    return logits_match, kv_match, full_top1, split_top1, kv_names, signature


def validate_verification_binding(
    verification: dict[str, object],
    *,
    provider: str,
    prompt_token_ids: Sequence[int],
    next_token_id: int,
) -> str:
    """Fail closed if the verifier result no longer supports its evidence claim."""

    if not isinstance(verification, dict):
        raise ValueError("cached-decode verifier result must be an object")
    if verification.get("schemaVersion") != VERIFICATION_SCHEMA_VERSION:
        raise ValueError(
            "cached-decode verifier returned an unexpected schemaVersion: "
            f"{verification.get('schemaVersion')!r}"
        )
    if verification.get("kind") != VERIFICATION_KIND:
        raise ValueError(
            "cached-decode verifier returned an unexpected kind: "
            f"{verification.get('kind')!r}"
        )
    if verification.get("decisionStatus") != "diagnostic-only":
        raise ValueError("cached-decode verifier must remain diagnostic-only")
    if verification.get("provider") != provider:
        raise ValueError("cached-decode verifier provider mismatch")
    if verification.get("promptTokenIds") != list(prompt_token_ids):
        raise ValueError("cached-decode verifier prompt token IDs mismatch")
    if verification.get("nextTokenId") != next_token_id:
        raise ValueError("cached-decode verifier next token ID mismatch")
    if verification.get("kvCacheOwnership") != "segment-local":
        raise ValueError("cached-decode verifier must report segment-local KV ownership")
    if verification.get("coordinatorRelaysKvCache") is not False:
        raise ValueError("cached-decode verifier must report coordinatorRelaysKvCache=false")
    if verification.get("sequentialSegmentSessionLoading") is not True:
        raise ValueError("cached-decode verifier must report sequentialSegmentSessionLoading=true")

    segment_count = _validate_artifact_integrity(verification.get("artifactIntegrity"))
    if segment_count < 2:
        raise ValueError("cached-decode evidence requires at least two generated segments")
    if _positive_int(verification.get("segmentCount"), field="verification.segmentCount") != segment_count:
        raise ValueError("cached-decode verifier segmentCount disagrees with artifactIntegrity")
    raw_cuts = verification.get("cutLayers")
    if not isinstance(raw_cuts, list) or len(raw_cuts) != segment_count - 1:
        raise ValueError("cached-decode verifier cutLayers must match segmentCount")
    cuts = [
        _positive_int(value, field=f"verification.cutLayers[{index}]")
        for index, value in enumerate(raw_cuts)
    ]
    if cuts != sorted(set(cuts)):
        raise ValueError("cached-decode verifier cutLayers must be strictly increasing")
    _validate_source_model(verification.get("sourceModel"))

    (
        prompt_logits,
        prompt_kv,
        prompt_full_top1,
        prompt_split_top1,
        prompt_names,
        prompt_boundaries,
    ) = _validate_step(
        verification.get("prompt"), field="verification.prompt", segment_count=segment_count
    )
    (
        decode_logits,
        decode_kv,
        decode_full_top1,
        decode_split_top1,
        decode_names,
        decode_boundaries,
    ) = _validate_step(
        verification.get("decode"), field="verification.decode", segment_count=segment_count
    )
    if not prompt_names or prompt_names != decode_names:
        raise ValueError(
            "cached-decode verifier prompt/decode KV tensor identities must be non-empty and identical"
        )
    if prompt_boundaries != decode_boundaries:
        raise ValueError("cached-decode verifier prompt/decode boundary topology must be identical")
    for index, (after, before, _) in enumerate(prompt_boundaries):
        cut = cuts[index]
        if after != cut - 1 or before != cut:
            raise ValueError(
                "cached-decode verifier boundary topology disagrees with cutLayers: "
                f"boundary={index}, after={after}, before={before}, cut={cut}"
            )

    decode = verification["decode"]
    assert isinstance(decode, dict)
    full_consumed = _non_negative_int(
        decode.get("fullPastCacheBytesConsumed"),
        field="verification.decode.fullPastCacheBytesConsumed",
    )
    split_consumed = _non_negative_int(
        decode.get("splitPastCacheBytesConsumed"),
        field="verification.decode.splitPastCacheBytesConsumed",
    )

    status = verification.get("status")
    if status not in {"pass", "fail"}:
        raise ValueError(f"cached-decode verifier returned unsupported status: {status!r}")
    derived = "pass" if all(
        (
            prompt_logits,
            decode_logits,
            prompt_kv,
            decode_kv,
            prompt_full_top1 == prompt_split_top1,
            decode_full_top1 == decode_split_top1,
            full_consumed > 0,
            split_consumed > 0,
        )
    ) else "fail"
    if status != derived:
        raise ValueError(
            "cached-decode verifier status contradicts comparisons/top-1/cache-consumption: "
            f"reported={status!r}, derived={derived!r}"
        )
    return str(status)


def collect_evidence(
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
    created_at: datetime | None = None,
) -> dict[str, object]:
    """Run the cached-decode verifier and attach reproduction metadata."""

    prompt, next_token, kv_heads, head_size, atol, rtol = validate_run_parameters(
        prompt_token_ids,
        next_token_id,
        kv_heads=kv_heads,
        head_size=head_size,
        atol=atol,
        rtol=rtol,
    )
    created_at_utc = _normalize_created_at(created_at)
    available_providers = ensure_provider_available(provider)
    verification = verify_multi_segment_kv_decode(
        full_model_path,
        manifest_path,
        prompt,
        next_token,
        provider=provider,
        kv_heads=kv_heads,
        head_size=head_size,
        atol=atol,
        rtol=rtol,
    )
    status = validate_verification_binding(
        verification,
        provider=provider,
        prompt_token_ids=prompt,
        next_token_id=next_token,
    )

    verification_sha = hashlib.sha256(canonical_json_bytes(verification)).hexdigest()
    return {
        "schemaVersion": EVIDENCE_SCHEMA_VERSION,
        "kind": EVIDENCE_KIND,
        "createdAt": created_at_utc,
        "status": status,
        "decisionStatus": "diagnostic-only",
        "parameters": {
            "provider": provider,
            "promptTokenIds": prompt,
            "nextTokenId": next_token,
            "kvHeads": kv_heads,
            "headSize": head_size,
            "atol": atol,
            "rtol": rtol,
        },
        "runtime": {
            "pythonVersion": platform.python_version(),
            "platform": platform.platform(),
            "numpyVersion": np.__version__,
            "onnxruntimeVersion": ort.__version__,
            "requestedProvider": provider,
            "availableProviders": list(available_providers),
        },
        "verificationSha256": verification_sha,
        "verification": verification,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full-model", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--input-ids", required=True, help="Comma-separated prompt token IDs")
    parser.add_argument("--next-token-id", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--provider", default="CPUExecutionProvider")
    parser.add_argument("--kv-heads", type=int, default=8)
    parser.add_argument("--head-size", type=int, default=64)
    parser.add_argument("--atol", type=float, default=1e-4)
    parser.add_argument("--rtol", type=float, default=1e-4)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    output_path = ensure_output_available(args.output)
    evidence = collect_evidence(
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
    evidence_sha = write_evidence(output_path, evidence)
    print(
        json.dumps(
            {
                "status": evidence["status"],
                "output": str(output_path),
                "evidenceSha256": evidence_sha,
                "verificationSha256": evidence["verificationSha256"],
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0 if evidence["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
