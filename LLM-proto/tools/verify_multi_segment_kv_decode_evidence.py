#!/usr/bin/env python3
"""Verify one persisted #167 cached-decode evidence bundle without rerunning inference.

The collector deliberately stores both the numerical verifier report and the
run envelope around it.  This tool treats that JSON as untrusted input: it
performs a bounded, stable regular-file read, validates the envelope, recomputes
the embedded verification digest, and reuses the collector's fail-closed
verification binding checks.  It never opens the ONNX model or split artifacts
and never creates an ONNX Runtime session.

This is an integrity/self-consistency check, not an authenticity mechanism.  A
party able to replace the entire evidence file can also replace internally
stored digests.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys

from collect_multi_segment_kv_decode_evidence import (
    EVIDENCE_KIND,
    EVIDENCE_SCHEMA_VERSION,
    canonical_json_bytes,
    validate_verification_binding,
)


DEFAULT_MAX_BYTES = 16 * 1024 * 1024
MAX_BYTES_ENV = "UNZEN_KV_DECODE_EVIDENCE_MAX_BYTES"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _positive_int(raw: object, *, field: str) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return raw


def _non_negative_int(raw: object, *, field: str) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return raw


def _finite_non_negative_number(raw: object, *, field: str) -> float:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(f"{field} must be a finite non-negative number")
    value = float(raw)
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{field} must be a finite non-negative number")
    return value


def _non_empty_string(raw: object, *, field: str) -> str:
    if not isinstance(raw, str) or not raw:
        raise ValueError(f"{field} must be a non-empty string")
    return raw


def _canonical_sha256(raw: object, *, field: str) -> str:
    value = _non_empty_string(raw, field=field)
    if SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field} must be a canonical lowercase SHA-256 digest")
    return value


def _max_input_bytes() -> int:
    raw = os.environ.get(MAX_BYTES_ENV)
    if raw is None:
        return DEFAULT_MAX_BYTES
    if not raw.isascii() or not raw.isdigit():
        raise ValueError(f"{MAX_BYTES_ENV} must be a positive base-10 integer")
    value = int(raw, 10)
    if value <= 0:
        raise ValueError(f"{MAX_BYTES_ENV} must be a positive base-10 integer")
    return value


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def read_stable_regular_file(path: Path, *, max_bytes: int | None = None) -> bytes:
    """Read a bounded regular file while rejecting symlinks and replacement/drift."""

    limit = _max_input_bytes() if max_bytes is None else _positive_int(max_bytes, field="max_bytes")
    candidate = path.expanduser().absolute()
    try:
        path_stat = os.lstat(candidate)
    except OSError as error:
        raise ValueError(f"evidence file is not readable: {candidate}: {error}") from error
    if stat.S_ISLNK(path_stat.st_mode):
        raise ValueError(f"evidence file must not be a symlink: {candidate}")
    if not stat.S_ISREG(path_stat.st_mode):
        raise ValueError(f"evidence file must be a regular file: {candidate}")
    if path_stat.st_size > limit:
        raise ValueError(f"evidence file exceeds {limit} bytes: {candidate}")

    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(candidate, flags)
    except OSError as error:
        raise ValueError(f"evidence file could not be opened safely: {candidate}: {error}") from error

    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError(f"evidence file must remain a regular file: {candidate}")
        if _stat_identity(before) != _stat_identity(path_stat):
            raise ValueError(f"evidence file changed between path check and open: {candidate}")
        if before.st_size > limit:
            raise ValueError(f"evidence file exceeds {limit} bytes: {candidate}")

        chunks: list[bytes] = []
        observed = 0
        while True:
            chunk = os.read(fd, min(1024 * 1024, limit + 1 - observed))
            if not chunk:
                break
            chunks.append(chunk)
            observed += len(chunk)
            if observed > limit:
                raise ValueError(f"evidence file grew beyond {limit} bytes while reading: {candidate}")

        after = os.fstat(fd)
        if _stat_identity(after) != _stat_identity(before):
            raise ValueError(f"evidence file changed while reading: {candidate}")
        if observed != before.st_size:
            raise ValueError(
                f"evidence file length changed while reading: expected={before.st_size}, observed={observed}"
            )
        return b"".join(chunks)
    finally:
        os.close(fd)


def load_evidence(path: Path) -> dict[str, object]:
    raw = read_stable_regular_file(path)
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ValueError("evidence file must contain valid UTF-8") from error
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError("evidence file must contain valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("evidence file must contain a JSON object")
    return value


def _validate_created_at(raw: object) -> str:
    value = _non_empty_string(raw, field="createdAt")
    if not value.endswith("Z"):
        raise ValueError("createdAt must be a UTC ISO-8601 timestamp ending in Z")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError("createdAt must be a valid UTC ISO-8601 timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ValueError("createdAt must be UTC")
    return value


def _validate_parameters(raw: object) -> tuple[str, list[int], int]:
    if not isinstance(raw, dict):
        raise ValueError("parameters must be an object")
    provider = _non_empty_string(raw.get("provider"), field="parameters.provider")
    prompt_raw = raw.get("promptTokenIds")
    if not isinstance(prompt_raw, list) or not prompt_raw:
        raise ValueError("parameters.promptTokenIds must be a non-empty array")
    prompt = [
        _non_negative_int(item, field=f"parameters.promptTokenIds[{index}]")
        for index, item in enumerate(prompt_raw)
    ]
    next_token = _non_negative_int(raw.get("nextTokenId"), field="parameters.nextTokenId")
    _positive_int(raw.get("kvHeads"), field="parameters.kvHeads")
    _positive_int(raw.get("headSize"), field="parameters.headSize")
    _finite_non_negative_number(raw.get("atol"), field="parameters.atol")
    _finite_non_negative_number(raw.get("rtol"), field="parameters.rtol")
    return provider, prompt, next_token


def _validate_runtime(raw: object, *, provider: str) -> None:
    if not isinstance(raw, dict):
        raise ValueError("runtime must be an object")
    for field in ("pythonVersion", "platform", "numpyVersion", "onnxruntimeVersion"):
        _non_empty_string(raw.get(field), field=f"runtime.{field}")
    if raw.get("requestedProvider") != provider:
        raise ValueError("runtime.requestedProvider must equal parameters.provider")
    providers = raw.get("availableProviders")
    if not isinstance(providers, list) or not providers:
        raise ValueError("runtime.availableProviders must be a non-empty array")
    normalized: list[str] = []
    for index, item in enumerate(providers):
        normalized.append(_non_empty_string(item, field=f"runtime.availableProviders[{index}]"))
    if len(normalized) != len(set(normalized)):
        raise ValueError("runtime.availableProviders must not contain duplicates")
    if provider not in normalized:
        raise ValueError("parameters.provider must be present in runtime.availableProviders")


def verify_evidence(evidence: dict[str, object]) -> dict[str, object]:
    """Verify one decoded evidence object and return a compact audit summary."""

    if evidence.get("schemaVersion") != EVIDENCE_SCHEMA_VERSION:
        raise ValueError(f"unexpected evidence schemaVersion: {evidence.get('schemaVersion')!r}")
    if evidence.get("kind") != EVIDENCE_KIND:
        raise ValueError(f"unexpected evidence kind: {evidence.get('kind')!r}")
    if evidence.get("decisionStatus") != "diagnostic-only":
        raise ValueError("cached-decode evidence must remain diagnostic-only")
    _validate_created_at(evidence.get("createdAt"))

    status = evidence.get("status")
    if status not in {"pass", "fail"}:
        raise ValueError("status must be 'pass' or 'fail'")
    provider, prompt, next_token = _validate_parameters(evidence.get("parameters"))
    _validate_runtime(evidence.get("runtime"), provider=provider)

    verification = evidence.get("verification")
    if not isinstance(verification, dict):
        raise ValueError("verification must be an object")
    expected_sha = _canonical_sha256(evidence.get("verificationSha256"), field="verificationSha256")
    observed_sha = hashlib.sha256(canonical_json_bytes(verification)).hexdigest()
    if observed_sha != expected_sha:
        raise ValueError(
            "verificationSha256 does not match the embedded verification report: "
            f"expected={expected_sha}, observed={observed_sha}"
        )

    derived_status = validate_verification_binding(
        verification,
        provider=provider,
        prompt_token_ids=prompt,
        next_token_id=next_token,
    )
    if status != derived_status:
        raise ValueError(
            "evidence status disagrees with embedded verification: "
            f"evidence={status!r}, verification={derived_status!r}"
        )

    segment_count = _positive_int(verification.get("segmentCount"), field="verification.segmentCount")
    return {
        "verified": True,
        "evidenceStatus": status,
        "decisionStatus": "diagnostic-only",
        "provider": provider,
        "promptTokenCount": len(prompt),
        "nextTokenId": next_token,
        "segmentCount": segment_count,
        "verificationSha256": observed_sha,
    }


def verify_evidence_file(path: Path) -> dict[str, object]:
    return verify_evidence(load_evidence(path))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path, help="Published cached-decode evidence JSON")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        summary = verify_evidence_file(args.evidence)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
