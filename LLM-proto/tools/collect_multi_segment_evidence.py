#!/usr/bin/env python3
"""Collect one provenance-rich #167 same-machine verification evidence file.

The numerical verifier already binds a generated multi-segment artifact set to
its source ONNX graph and external data before creating ONNX Runtime sessions.
This wrapper adds run provenance that is useful when the real 1B q4 evidence is
captured outside CI: exact tolerance/cache-shape parameters, Python/numpy/ORT
versions, requested/available execution providers, a digest of the embedded
verification report, and an atomic no-clobber JSON write.

A requested execution provider must be available locally. This avoids producing
an evidence envelope labelled for a provider that ONNX Runtime could not load.
The returned verifier report is also revalidated before it is persisted so a
future verifier regression cannot emit a passing evidence bundle without the
artifact/source identity and relay-measurement fields that make the result
auditable.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import operator
import os
from pathlib import Path
import platform
import re
import secrets
from typing import Sequence

import numpy as np
import onnxruntime as ort

from verify_multi_segment_onnx import verify_multi_split
from verify_split_onnx import parse_token_ids


EVIDENCE_KIND = "unzen-budgeted-multi-segment-evidence-bundle"
EVIDENCE_SCHEMA_VERSION = "1.0.0"
VERIFICATION_KIND = "unzen-budgeted-multi-segment-same-machine-verification"
VERIFICATION_SCHEMA_VERSION = "1.1.0"
ARTIFACT_INTEGRITY_KIND = "unzen-budgeted-multi-segment-artifact-integrity"
ARTIFACT_INTEGRITY_SCHEMA_VERSION = "1.0.0"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def canonical_json_bytes(value: object) -> bytes:
    """Return the stable JSON encoding used for embedded-report digests."""

    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def ensure_provider_available(provider: str) -> tuple[str, ...]:
    """Fail closed before numerical execution when ORT cannot load the provider."""

    if not provider:
        raise ValueError("provider must be a non-empty ONNX Runtime provider name")
    available = tuple(str(item) for item in ort.get_available_providers())
    if provider not in available:
        raise ValueError(
            f"requested ONNX Runtime provider {provider!r} is unavailable; "
            f"available={list(available)!r}"
        )
    return available


def _canonical_sha256(raw: object, *, field: str) -> str:
    value = str(raw or "")
    if not SHA256_RE.fullmatch(value):
        raise ValueError(f"{field} must be a canonical lowercase SHA-256 digest")
    return value


def _non_negative_int(raw: object, *, field: str) -> int:
    if isinstance(raw, bool):
        raise ValueError(f"{field} must be a non-negative integer")
    try:
        value = operator.index(raw)
    except TypeError as error:
        raise ValueError(f"{field} must be a non-negative integer") from error
    if value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return int(value)


def _positive_int(raw: object, *, field: str) -> int:
    value = _non_negative_int(raw, field=field)
    if value <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return value


def _finite_non_negative_float(raw: object, *, field: str) -> float:
    if isinstance(raw, bool):
        raise ValueError(f"{field} must be a finite non-negative number")
    try:
        value = float(raw)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be a finite non-negative number") from error
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{field} must be a finite non-negative number")
    return value


def _shape(raw: object, *, field: str) -> list[int]:
    if not isinstance(raw, list):
        raise ValueError(f"{field} must be an array")
    return [
        _non_negative_int(value, field=f"{field}[{index}]")
        for index, value in enumerate(raw)
    ]


def validate_run_parameters(
    token_ids: Sequence[int],
    *,
    kv_heads: int,
    head_size: int,
    atol: float,
    rtol: float,
) -> tuple[list[int], int, int, float, float]:
    """Reject malformed evidence parameters before any expensive ORT work."""

    if not token_ids:
        raise ValueError("at least one token ID is required")
    normalized_tokens = [
        _non_negative_int(value, field=f"inputTokenIds[{index}]")
        for index, value in enumerate(token_ids)
    ]
    return (
        normalized_tokens,
        _positive_int(kv_heads, field="kvHeads"),
        _positive_int(head_size, field="headSize"),
        _finite_non_negative_float(atol, field="atol"),
        _finite_non_negative_float(rtol, field="rtol"),
    )


def _validate_artifact_integrity(artifact_integrity: object) -> int:
    if not isinstance(artifact_integrity, dict):
        raise ValueError("numerical verifier artifactIntegrity must be an object")
    if artifact_integrity.get("schemaVersion") != ARTIFACT_INTEGRITY_SCHEMA_VERSION:
        raise ValueError(
            "numerical verifier artifactIntegrity schemaVersion mismatch: "
            f"{artifact_integrity.get('schemaVersion')!r}"
        )
    if artifact_integrity.get("kind") != ARTIFACT_INTEGRITY_KIND:
        raise ValueError(
            "numerical verifier artifactIntegrity kind mismatch: "
            f"{artifact_integrity.get('kind')!r}"
        )
    if artifact_integrity.get("status") != "pass":
        raise ValueError("numerical verifier artifactIntegrity must have status='pass'")
    _canonical_sha256(
        artifact_integrity.get("manifestSha256"),
        field="verification.artifactIntegrity.manifestSha256",
    )

    segment_count = _positive_int(
        artifact_integrity.get("segmentCount"),
        field="verification.artifactIntegrity.segmentCount",
    )
    required_max = _positive_int(
        artifact_integrity.get("effectiveRequiredMaxBytes"),
        field="verification.artifactIntegrity.effectiveRequiredMaxBytes",
    )
    reported_maximum = _non_negative_int(
        artifact_integrity.get("maximumSegmentArtifactBytes"),
        field="verification.artifactIntegrity.maximumSegmentArtifactBytes",
    )
    raw_segments = artifact_integrity.get("segments")
    if not isinstance(raw_segments, list) or len(raw_segments) != segment_count:
        raise ValueError(
            "numerical verifier artifactIntegrity.segments must match segmentCount"
        )

    observed_maximum = 0
    for expected_index, entry in enumerate(raw_segments):
        if not isinstance(entry, dict):
            raise ValueError(
                f"verification.artifactIntegrity.segments[{expected_index}] must be an object"
            )
        prefix = f"verification.artifactIntegrity.segments[{expected_index}]"
        index = _non_negative_int(entry.get("index"), field=f"{prefix}.index")
        if index != expected_index:
            raise ValueError(f"{prefix}.index must equal {expected_index}")
        if not str(entry.get("path") or ""):
            raise ValueError(f"{prefix}.path must be non-empty")
        graph_bytes = _non_negative_int(
            entry.get("graphBytes"), field=f"{prefix}.graphBytes"
        )
        _canonical_sha256(entry.get("graphSha256"), field=f"{prefix}.graphSha256")

        raw_external = entry.get("externalData")
        if not isinstance(raw_external, list):
            raise ValueError(f"{prefix}.externalData must be an array")
        external_sum = 0
        seen_locations: set[str] = set()
        for external_index, external in enumerate(raw_external):
            if not isinstance(external, dict):
                raise ValueError(
                    f"{prefix}.externalData[{external_index}] must be an object"
                )
            external_prefix = f"{prefix}.externalData[{external_index}]"
            location = str(external.get("location") or "")
            if not location or location in seen_locations:
                raise ValueError(
                    f"{external_prefix}.location must be non-empty and unique"
                )
            seen_locations.add(location)
            external_sum += _non_negative_int(
                external.get("bytes"), field=f"{external_prefix}.bytes"
            )
            _canonical_sha256(
                external.get("sha256"), field=f"{external_prefix}.sha256"
            )

        external_bytes = _non_negative_int(
            entry.get("externalBytes"), field=f"{prefix}.externalBytes"
        )
        if external_bytes != external_sum:
            raise ValueError(
                f"{prefix}.externalBytes does not match externalData byte sum"
            )
        artifact_bytes = _non_negative_int(
            entry.get("artifactBytes"), field=f"{prefix}.artifactBytes"
        )
        if artifact_bytes != graph_bytes + external_bytes:
            raise ValueError(
                f"{prefix}.artifactBytes does not match graph + external bytes"
            )
        if artifact_bytes > required_max:
            raise ValueError(
                f"{prefix}.artifactBytes exceeds effectiveRequiredMaxBytes"
            )
        if entry.get("tier") not in {"preferred", "normal", "degraded"}:
            raise ValueError(
                f"{prefix}.tier must be preferred, normal, or degraded"
            )
        observed_maximum = max(observed_maximum, artifact_bytes)

    if reported_maximum != observed_maximum:
        raise ValueError(
            "numerical verifier artifactIntegrity maximumSegmentArtifactBytes mismatch"
        )
    return segment_count


def _validate_boundaries(
    verification: dict[str, object], *, segment_count: int
) -> None:
    raw_boundaries = verification.get("boundaries")
    expected_count = max(0, segment_count - 1)
    if not isinstance(raw_boundaries, list) or len(raw_boundaries) != expected_count:
        raise ValueError(
            f"numerical verifier boundaries must contain {expected_count} entries"
        )

    total_bytes = 0
    for boundary_index, boundary in enumerate(raw_boundaries):
        if not isinstance(boundary, dict):
            raise ValueError(
                f"verification.boundaries[{boundary_index}] must be an object"
            )
        prefix = f"verification.boundaries[{boundary_index}]"
        after = _non_negative_int(
            boundary.get("afterLayer"), field=f"{prefix}.afterLayer"
        )
        before = _non_negative_int(
            boundary.get("beforeLayer"), field=f"{prefix}.beforeLayer"
        )
        if before != after + 1:
            raise ValueError(f"{prefix} must connect adjacent layers")
        raw_tensors = boundary.get("tensors")
        if not isinstance(raw_tensors, list) or not raw_tensors:
            raise ValueError(f"{prefix}.tensors must be a non-empty array")
        tensor_sum = 0
        seen_names: set[str] = set()
        for tensor_index, tensor in enumerate(raw_tensors):
            if not isinstance(tensor, dict):
                raise ValueError(
                    f"{prefix}.tensors[{tensor_index}] must be an object"
                )
            tensor_prefix = f"{prefix}.tensors[{tensor_index}]"
            name = str(tensor.get("name") or "")
            if not name or name in seen_names:
                raise ValueError(
                    f"{tensor_prefix}.name must be non-empty and unique"
                )
            seen_names.add(name)
            _shape(tensor.get("shape"), field=f"{tensor_prefix}.shape")
            if not str(tensor.get("dtype") or ""):
                raise ValueError(f"{tensor_prefix}.dtype must be non-empty")
            tensor_sum += _non_negative_int(
                tensor.get("bytes"), field=f"{tensor_prefix}.bytes"
            )
        boundary_bytes = _non_negative_int(
            boundary.get("bytes"), field=f"{prefix}.bytes"
        )
        if boundary_bytes != tensor_sum:
            raise ValueError(f"{prefix}.bytes does not match tensor byte sum")
        total_bytes += boundary_bytes

    reported_total = _non_negative_int(
        verification.get("boundaryBytes"), field="verification.boundaryBytes"
    )
    if reported_total != total_bytes:
        raise ValueError(
            "numerical verifier boundaryBytes does not match boundary byte sum"
        )


def validate_verification_binding(
    verification: dict[str, object],
    *,
    provider: str,
    token_ids: Sequence[int],
) -> str:
    """Require the persisted verifier result to retain its evidence contract."""

    if verification.get("schemaVersion") != VERIFICATION_SCHEMA_VERSION:
        raise ValueError(
            "numerical verifier returned an unexpected schemaVersion: "
            f"{verification.get('schemaVersion')!r}"
        )
    if verification.get("kind") != VERIFICATION_KIND:
        raise ValueError(
            "numerical verifier returned an unexpected kind: "
            f"{verification.get('kind')!r}"
        )

    status = verification.get("status")
    if status not in {"pass", "fail"}:
        raise ValueError(
            f"numerical verifier returned an unsupported status: {status!r}"
        )

    if verification.get("provider") != provider:
        raise ValueError(
            "numerical verifier provider mismatch: "
            f"requested={provider!r}, reported={verification.get('provider')!r}"
        )

    reported_token_ids = verification.get("inputTokenIds")
    expected_token_ids = list(token_ids)
    if reported_token_ids != expected_token_ids:
        raise ValueError(
            "numerical verifier token IDs mismatch: "
            f"requested={expected_token_ids!r}, reported={reported_token_ids!r}"
        )

    segment_count = _validate_artifact_integrity(
        verification.get("artifactIntegrity")
    )
    if (
        _positive_int(
            verification.get("segmentCount"), field="verification.segmentCount"
        )
        != segment_count
    ):
        raise ValueError(
            "numerical verifier segmentCount disagrees with artifactIntegrity"
        )
    raw_cuts = verification.get("cutLayers")
    if not isinstance(raw_cuts, list) or len(raw_cuts) != max(0, segment_count - 1):
        raise ValueError("numerical verifier cutLayers must match segmentCount")
    cut_layers = [
        _positive_int(value, field=f"verification.cutLayers[{index}]")
        for index, value in enumerate(raw_cuts)
    ]
    if cut_layers != sorted(set(cut_layers)):
        raise ValueError("numerical verifier cutLayers must be strictly increasing")

    source_model = verification.get("sourceModel")
    if not isinstance(source_model, dict):
        raise ValueError("numerical verifier sourceModel must be an object")
    _non_negative_int(
        source_model.get("graphBytes"), field="verification.sourceModel.graphBytes"
    )
    _canonical_sha256(
        source_model.get("graphSha256"),
        field="verification.sourceModel.graphSha256",
    )
    if source_model.get("allExternalDataHashed") is not True:
        raise ValueError("numerical verifier sourceModel must hash all external data")
    external_data = source_model.get("externalData")
    if not isinstance(external_data, list):
        raise ValueError("numerical verifier sourceModel.externalData must be an array")
    seen_source_locations: set[str] = set()
    for index, entry in enumerate(external_data):
        if not isinstance(entry, dict):
            raise ValueError(
                f"numerical verifier sourceModel.externalData[{index}] must be an object"
            )
        prefix = f"verification.sourceModel.externalData[{index}]"
        location = str(entry.get("location") or "")
        if not location or location in seen_source_locations:
            raise ValueError(f"{prefix}.location must be non-empty and unique")
        seen_source_locations.add(location)
        _non_negative_int(entry.get("bytes"), field=f"{prefix}.bytes")
        _canonical_sha256(entry.get("sha256"), field=f"{prefix}.sha256")

    _validate_boundaries(verification, segment_count=segment_count)

    comparison = verification.get("comparison")
    if not isinstance(comparison, dict) or not isinstance(
        comparison.get("matches"), bool
    ):
        raise ValueError("numerical verifier comparison.matches must be boolean")
    if not isinstance(comparison.get("shapeMatch"), bool):
        raise ValueError("numerical verifier comparison.shapeMatch must be boolean")
    full_shape = _shape(
        comparison.get("fullShape"), field="verification.comparison.fullShape"
    )
    split_shape = _shape(
        comparison.get("splitShape"), field="verification.comparison.splitShape"
    )
    shape_match = bool(comparison["shapeMatch"])
    if shape_match != (full_shape == split_shape):
        raise ValueError(
            "numerical verifier comparison.shapeMatch contradicts reported shapes"
        )
    max_abs_diff = comparison.get("maxAbsDiff")
    if shape_match:
        _finite_non_negative_float(
            max_abs_diff, field="verification.comparison.maxAbsDiff"
        )
    elif max_abs_diff is not None:
        raise ValueError(
            "numerical verifier comparison.maxAbsDiff must be null on shape mismatch"
        )

    matches = bool(comparison["matches"])
    if matches and not shape_match:
        raise ValueError(
            "numerical verifier comparison.matches cannot pass on shape mismatch"
        )
    full_top1 = _non_negative_int(
        verification.get("fullTop1TokenId"),
        field="verification.fullTop1TokenId",
    )
    split_top1 = _non_negative_int(
        verification.get("splitTop1TokenId"),
        field="verification.splitTop1TokenId",
    )
    derived_status = "pass" if matches and full_top1 == split_top1 else "fail"
    if status != derived_status:
        raise ValueError(
            "numerical verifier status contradicts comparison/top-1 result: "
            f"reported={status!r}, derived={derived_status!r}"
        )

    if verification.get("sequentialSessionLoading") is not True:
        raise ValueError("numerical verifier must report sequentialSessionLoading=true")

    return str(status)


def collect_evidence(
    full_model_path: Path,
    manifest_path: Path,
    token_ids: Sequence[int],
    *,
    provider: str = "CPUExecutionProvider",
    kv_heads: int = 8,
    head_size: int = 64,
    atol: float = 1e-4,
    rtol: float = 1e-4,
    created_at: datetime | None = None,
) -> dict[str, object]:
    """Run the existing verifier and attach reproducibility/provenance fields."""

    input_token_ids, kv_heads, head_size, atol, rtol = validate_run_parameters(
        token_ids,
        kv_heads=kv_heads,
        head_size=head_size,
        atol=atol,
        rtol=rtol,
    )
    available_providers = ensure_provider_available(provider)
    verification = verify_multi_split(
        full_model_path,
        manifest_path,
        input_token_ids,
        provider=provider,
        kv_heads=kv_heads,
        head_size=head_size,
        atol=atol,
        rtol=rtol,
    )
    status = validate_verification_binding(
        verification,
        provider=provider,
        token_ids=input_token_ids,
    )

    timestamp = created_at or datetime.now(timezone.utc)
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError("created_at must be timezone-aware")
    created_at_utc = (
        timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    )

    verification_sha = hashlib.sha256(
        canonical_json_bytes(verification)
    ).hexdigest()
    return {
        "schemaVersion": EVIDENCE_SCHEMA_VERSION,
        "kind": EVIDENCE_KIND,
        "createdAt": created_at_utc,
        "status": status,
        "parameters": {
            "provider": provider,
            "inputTokenIds": input_token_ids,
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


def ensure_output_available(path: Path) -> Path:
    """Reject an occupied output path before starting an expensive 1B run."""

    destination = path.expanduser().absolute()
    if os.path.lexists(destination):
        raise FileExistsError(f"evidence output already exists: {destination}")
    parent = destination.parent
    if parent.exists() and not parent.is_dir():
        raise NotADirectoryError(
            f"evidence output parent is not a directory: {parent}"
        )
    return destination


def write_evidence(path: Path, evidence: dict[str, object]) -> str:
    """Atomically publish a complete JSON file without overwriting prior evidence."""

    destination = path.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(evidence, indent=2, ensure_ascii=False) + "\n").encode(
        "utf-8"
    )

    temporary = destination.with_name(
        f".{destination.name}.{os.getpid()}.{secrets.token_hex(6)}.tmp"
    )
    try:
        with temporary.open("xb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())

        # Hard-link publication gives O_EXCL-style no-clobber semantics while
        # exposing only the already-complete temporary inode at destination.
        os.link(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)

    return hashlib.sha256(encoded).hexdigest()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full-model", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--input-ids", required=True, help="Comma-separated token IDs")
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
