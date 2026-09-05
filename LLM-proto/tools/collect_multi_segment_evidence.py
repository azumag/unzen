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
artifact/source identity fields that make the result auditable.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
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
        value = int(raw)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be a non-negative integer") from error
    if value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def validate_verification_binding(
    verification: dict[str, object],
    *,
    provider: str,
    token_ids: Sequence[int],
) -> str:
    """Require the persisted verifier result to retain its evidence contract."""

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

    artifact_integrity = verification.get("artifactIntegrity")
    if not isinstance(artifact_integrity, dict):
        raise ValueError("numerical verifier artifactIntegrity must be an object")
    if artifact_integrity.get("status") != "pass":
        raise ValueError("numerical verifier artifactIntegrity must have status='pass'")
    _canonical_sha256(
        artifact_integrity.get("manifestSha256"),
        field="verification.artifactIntegrity.manifestSha256",
    )

    source_model = verification.get("sourceModel")
    if not isinstance(source_model, dict):
        raise ValueError("numerical verifier sourceModel must be an object")
    _canonical_sha256(
        source_model.get("graphSha256"),
        field="verification.sourceModel.graphSha256",
    )
    if source_model.get("allExternalDataHashed") is not True:
        raise ValueError("numerical verifier sourceModel must hash all external data")
    external_data = source_model.get("externalData")
    if not isinstance(external_data, list):
        raise ValueError("numerical verifier sourceModel.externalData must be an array")
    for index, entry in enumerate(external_data):
        if not isinstance(entry, dict):
            raise ValueError(
                f"numerical verifier sourceModel.externalData[{index}] must be an object"
            )
        _non_negative_int(
            entry.get("bytes"),
            field=f"verification.sourceModel.externalData[{index}].bytes",
        )
        _canonical_sha256(
            entry.get("sha256"),
            field=f"verification.sourceModel.externalData[{index}].sha256",
        )

    comparison = verification.get("comparison")
    if not isinstance(comparison, dict) or not isinstance(comparison.get("matches"), bool):
        raise ValueError("numerical verifier comparison.matches must be boolean")
    matches = bool(comparison["matches"])
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

    available_providers = ensure_provider_available(provider)
    input_token_ids = list(token_ids)
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
    created_at_utc = timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    verification_sha = hashlib.sha256(canonical_json_bytes(verification)).hexdigest()
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
        raise NotADirectoryError(f"evidence output parent is not a directory: {parent}")
    return destination


def write_evidence(path: Path, evidence: dict[str, object]) -> str:
    """Atomically publish a complete JSON file without overwriting prior evidence."""

    destination = path.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(evidence, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

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
