#!/usr/bin/env python3
"""Cross-bind source-model provenance inside a published #167 capture bundle.

The existing capture-bundle verifier proves that the published run summary,
numerical evidence, split manifest, and generated segment artifacts form one
self-consistent capture bundle.  This follow-up audit closes a narrower source
provenance gap: the split manifest's source graph/external-data identity must be
exactly the same identity measured by the numerical verifier.

The original source model does not need to remain on disk.  This is deliberately
an offline, read-only audit over the persisted capture bundle.  It does not
claim evidence-author authenticity, source-file availability, WebGPU execution,
GPU-memory reclamation, multi-browser relay/resume, or production suitability.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat

from verify_multi_segment_capture_bundle import verify_capture_bundle


REPORT_SCHEMA_VERSION = "1.0.0"
REPORT_KIND = "unzen-budgeted-multi-segment-capture-source-provenance-verification"
DEFAULT_JSON_MAX_BYTES = 16 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
WINDOWS_RESERVED_DEVICE_STEMS = {"CON", "PRN", "AUX", "NUL"}
WINDOWS_RESERVED_PORT_RE = re.compile(r"^(?:COM|LPT)(?:[1-9]|[¹²³])$")


def _identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _stable_json_object(path: Path, *, field: str) -> tuple[dict[str, object], str]:
    """Read one bounded non-symlink regular JSON file and return its exact digest."""

    path = path.expanduser().absolute()
    try:
        before = os.lstat(path)
    except OSError as error:
        raise ValueError(f"{field} is not readable: {path}: {error}") from error
    if stat.S_ISLNK(before.st_mode):
        raise ValueError(f"{field} must not be a symlink: {path}")
    if not stat.S_ISREG(before.st_mode):
        raise ValueError(f"{field} must be a regular file: {path}")
    if before.st_size > DEFAULT_JSON_MAX_BYTES:
        raise ValueError(
            f"{field} exceeds {DEFAULT_JSON_MAX_BYTES} bytes: {path}"
        )

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except OSError as error:
        raise ValueError(f"{field} could not be opened safely: {path}: {error}") from error

    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise ValueError(f"{field} must remain a regular file: {path}")
        if _identity(opened) != _identity(before):
            raise ValueError(f"{field} changed between path check and open: {path}")
        if opened.st_size > DEFAULT_JSON_MAX_BYTES:
            raise ValueError(
                f"{field} exceeds {DEFAULT_JSON_MAX_BYTES} bytes: {path}"
            )

        chunks: list[bytes] = []
        observed = 0
        while True:
            remaining = DEFAULT_JSON_MAX_BYTES + 1 - observed
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            observed += len(chunk)
            if observed > DEFAULT_JSON_MAX_BYTES:
                raise ValueError(f"{field} grew beyond the input limit: {path}")

        after_fd = os.fstat(fd)
        if _identity(after_fd) != _identity(opened) or observed != after_fd.st_size:
            raise ValueError(f"{field} changed while being read: {path}")
    finally:
        os.close(fd)

    try:
        after_path = os.lstat(path)
    except OSError as error:
        raise ValueError(f"{field} path disappeared after read: {path}: {error}") from error
    if stat.S_ISLNK(after_path.st_mode) or _identity(after_path) != _identity(opened):
        raise ValueError(f"{field} path changed while being read: {path}")

    raw = b"".join(chunks)
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ValueError(f"{field} is not valid UTF-8: {path}") from error
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"{field} is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{field} must contain a JSON object")
    return value, hashlib.sha256(raw).hexdigest()


def _mapping(raw: object, *, field: str) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise ValueError(f"{field} must be an object")
    return raw


def _text(raw: object, *, field: str) -> str:
    if not isinstance(raw, str) or not raw:
        raise ValueError(f"{field} must be a non-empty string")
    return raw


def _canonical_sha256(raw: object, *, field: str) -> str:
    value = _text(raw, field=field)
    if not SHA256_RE.fullmatch(value):
        raise ValueError(f"{field} must be a canonical lowercase SHA-256 digest")
    return value


def _non_negative_int(raw: object, *, field: str) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return raw


def _unsafe_windows_component(part: str) -> bool:
    if part.endswith((".", " ")):
        return True
    stem = part.split(".", 1)[0].upper()
    return stem in WINDOWS_RESERVED_DEVICE_STEMS or bool(
        WINDOWS_RESERVED_PORT_RE.fullmatch(stem)
    )


def _safe_relative(raw: object, *, field: str) -> str:
    value = _text(raw, field=field)
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or bool(windows.drive)
        or bool(windows.root)
        or any(":" in part for part in windows.parts)
        or any(_unsafe_windows_component(part) for part in windows.parts)
        or ".." in posix.parts
        or ".." in windows.parts
    ):
        raise ValueError(f"unsafe {field}: {value}")
    parts = tuple(Path(value).parts)
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise ValueError(f"unsafe {field}: {value}")
    return value


def _capture_path(root: Path, raw: object, *, field: str) -> Path:
    value = _safe_relative(raw, field=field)
    root = root.expanduser().absolute()
    candidate = (root / Path(value)).absolute()
    resolved_root = root.resolve()
    resolved_parent = candidate.parent.resolve()
    if resolved_parent != resolved_root and resolved_root not in resolved_parent.parents:
        raise ValueError(f"{field} escapes capture directory: {value}")
    return candidate


def _source_external_identity(
    raw: object,
    *,
    field: str,
) -> dict[str, tuple[int, str]]:
    if not isinstance(raw, list):
        raise ValueError(f"{field} must be an array")
    result: dict[str, tuple[int, str]] = {}
    for index, entry_raw in enumerate(raw):
        entry = _mapping(entry_raw, field=f"{field}[{index}]")
        prefix = f"{field}[{index}]"
        location = _safe_relative(entry.get("location"), field=f"{prefix}.location")
        if location in result:
            raise ValueError(f"{field} contains duplicate location: {location}")
        byte_size = _non_negative_int(entry.get("bytes"), field=f"{prefix}.bytes")
        digest = _canonical_sha256(entry.get("sha256"), field=f"{prefix}.sha256")
        result[location] = (byte_size, digest)
    return result


def _require_digest(actual: str, expected: object, *, field: str) -> None:
    expected_digest = _canonical_sha256(expected, field=field)
    if actual != expected_digest:
        raise ValueError(
            f"{field} changed after base bundle verification: "
            f"expected={expected_digest}, observed={actual}"
        )


def verify_capture_source_provenance(capture_dir: Path) -> dict[str, object]:
    """Cross-bind source graph and external-data identities in one capture bundle."""

    root = capture_dir.expanduser().absolute()
    base = verify_capture_bundle(root)
    if not isinstance(base, dict) or base.get("status") != "pass":
        raise RuntimeError("base capture-bundle verification did not pass")

    summary, summary_sha = _stable_json_object(
        root / "run-summary.json",
        field="run summary",
    )
    _require_digest(
        summary_sha,
        base.get("runSummarySha256"),
        field="base.runSummarySha256",
    )

    summary_artifacts = _mapping(
        summary.get("artifacts"),
        field="run-summary.artifacts",
    )
    manifest_path = _capture_path(
        root,
        summary_artifacts.get("manifest"),
        field="run-summary.artifacts.manifest",
    )
    manifest, manifest_sha = _stable_json_object(
        manifest_path,
        field="split manifest",
    )
    _require_digest(
        manifest_sha,
        base.get("manifestSha256"),
        field="base.manifestSha256",
    )

    summary_evidence = _mapping(
        summary.get("evidence"),
        field="run-summary.evidence",
    )
    evidence_path = _capture_path(
        root,
        summary_evidence.get("path"),
        field="run-summary.evidence.path",
    )
    evidence, evidence_sha = _stable_json_object(
        evidence_path,
        field="same-machine evidence",
    )
    _require_digest(
        evidence_sha,
        base.get("evidenceSha256"),
        field="base.evidenceSha256",
    )

    summary_source = _mapping(
        summary.get("sourceModel"),
        field="run-summary.sourceModel",
    )
    manifest_source = _mapping(
        manifest.get("sourceModel"),
        field="split-manifest.sourceModel",
    )
    verification = _mapping(
        evidence.get("verification"),
        field="same-machine-evidence.verification",
    )
    verification_source = _mapping(
        verification.get("sourceModel"),
        field="same-machine-evidence.verification.sourceModel",
    )

    summary_graph = _canonical_sha256(
        summary_source.get("graphSha256"),
        field="run-summary.sourceModel.graphSha256",
    )
    manifest_graph = _canonical_sha256(
        manifest_source.get("sha256"),
        field="split-manifest.sourceModel.sha256",
    )
    verification_graph = _canonical_sha256(
        verification_source.get("graphSha256"),
        field="same-machine-evidence.verification.sourceModel.graphSha256",
    )
    if not summary_graph == manifest_graph == verification_graph:
        raise ValueError(
            "source graph identity mismatch across summary/manifest/verification: "
            f"summary={summary_graph}, manifest={manifest_graph}, "
            f"verification={verification_graph}"
        )

    if verification_source.get("allExternalDataHashed") is not True:
        raise ValueError(
            "same-machine-evidence.verification.sourceModel.allExternalDataHashed "
            "must be true"
        )
    manifest_external = _source_external_identity(
        manifest_source.get("externalData"),
        field="split-manifest.sourceModel.externalData",
    )
    verification_external = _source_external_identity(
        verification_source.get("externalData"),
        field="same-machine-evidence.verification.sourceModel.externalData",
    )
    if manifest_external != verification_external:
        raise ValueError(
            "source external-data identity mismatch between split manifest and "
            "numerical verification"
        )

    total_external_bytes = sum(value[0] for value in manifest_external.values())
    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "decisionStatus": "diagnostic-only",
        "sourceGraphSha256": summary_graph,
        "sourceExternalDataCount": len(manifest_external),
        "sourceExternalDataBytes": total_external_bytes,
        "runSummarySha256": summary_sha,
        "evidenceSha256": evidence_sha,
        "manifestSha256": manifest_sha,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-dir", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = verify_capture_source_provenance(args.capture_dir)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
