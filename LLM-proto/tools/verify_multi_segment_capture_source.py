#!/usr/bin/env python3
"""Verify the original full-model identity behind a published #167 capture.

``verify_multi_segment_capture_bundle.py`` proves that the files inside a capture
bundle still agree with one another. The original full ONNX graph and its
external-data files intentionally stay outside that bundle, though, so they need
an independent audit if an operator wants to prove that the published numerical
evidence still names the exact source artifacts on disk.

This verifier is stdlib-only. It first reuses the published-bundle verifier, then
binds the same bundle snapshot to the caller-supplied full model and every source
external-data file recorded in the split manifest. ONNX Runtime is never loaded.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
from typing import Callable

from verify_multi_segment_artifacts import sha256_file
from verify_multi_segment_capture_bundle import verify_capture_bundle


REPORT_KIND = "unzen-budgeted-multi-segment-capture-source-verification"
REPORT_SCHEMA_VERSION = "1.0.0"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _json_object(path: Path, *, field: str) -> dict[str, object]:
    if not path.is_file():
        raise FileNotFoundError(f"{field} not found: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{field} is not valid UTF-8 JSON: {path}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{field} must contain a JSON object")
    return value


def _require_mapping(raw: object, *, field: str) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise ValueError(f"{field} must be an object")
    return raw


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


def _safe_relative_path(root: Path, raw: object, *, field: str) -> Path:
    value = str(raw or "")
    if not value:
        raise ValueError(f"{field} must be a non-empty relative path")
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or ".." in posix.parts
        or ".." in windows.parts
    ):
        raise ValueError(f"unsafe {field}: {value}")
    resolved_root = root.resolve()
    resolved = (root / Path(value)).resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise ValueError(f"{field} escapes its root: {value}")
    return resolved


def _stable_identity(
    path: Path,
    *,
    field: str,
    hasher: Callable[[Path], str] = sha256_file,
) -> tuple[int, str]:
    """Hash one file and reject replacement or mutation while hashing it."""

    if not path.is_file():
        raise FileNotFoundError(f"{field} not found: {path}")
    before = path.stat()
    digest = hasher(path)
    after = path.stat()
    before_identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    after_identity = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if before_identity != after_identity:
        raise RuntimeError(f"{field} changed while it was being hashed: {path}")
    return after.st_size, digest


def _normalized_external_entries(
    raw: object,
    *,
    field: str,
) -> list[dict[str, object]]:
    if not isinstance(raw, list):
        raise ValueError(f"{field} must be an array")
    normalized: list[dict[str, object]] = []
    seen: set[str] = set()
    for index, raw_entry in enumerate(raw):
        prefix = f"{field}[{index}]"
        entry = _require_mapping(raw_entry, field=prefix)
        location = str(entry.get("location") or "")
        if not location:
            raise ValueError(f"{prefix}.location must be non-empty")
        # Validate cross-platform path semantics even before a filesystem root is
        # applied. This prevents an embedded report from smuggling an absolute or
        # parent-relative identity that merely differs textually from the manifest.
        posix = PurePosixPath(location)
        windows = PureWindowsPath(location)
        if (
            posix.is_absolute()
            or windows.is_absolute()
            or ".." in posix.parts
            or ".." in windows.parts
        ):
            raise ValueError(f"unsafe {prefix}.location: {location}")
        if location in seen:
            raise ValueError(f"duplicate external-data location in {field}: {location}")
        seen.add(location)
        normalized.append(
            {
                "location": location,
                "bytes": _non_negative_int(
                    entry.get("bytes"),
                    field=f"{prefix}.bytes",
                ),
                "sha256": _canonical_sha256(
                    entry.get("sha256"),
                    field=f"{prefix}.sha256",
                ),
            }
        )
    return sorted(normalized, key=lambda item: str(item["location"]))


def _require_equal(left: object, right: object, *, field: str) -> None:
    if left != right:
        raise ValueError(f"{field} mismatch: expected={left!r}, observed={right!r}")


def verify_capture_source(
    capture_dir: Path,
    full_model_path: Path,
    *,
    file_hasher: Callable[[Path], str] = sha256_file,
) -> dict[str, object]:
    """Bind a valid published capture bundle to its original source artifacts."""

    root = capture_dir.expanduser().absolute()
    full_model = full_model_path.expanduser().absolute()
    bundle = verify_capture_bundle(root)
    if bundle.get("status") != "pass":
        raise RuntimeError("published capture bundle verification did not pass")

    summary_path = root / "run-summary.json"
    summary = _json_object(summary_path, field="run summary")
    summary_artifacts = _require_mapping(
        summary.get("artifacts"),
        field="run-summary.artifacts",
    )
    manifest_path = _safe_relative_path(
        root,
        summary_artifacts.get("manifest"),
        field="run-summary.artifacts.manifest",
    )
    summary_evidence = _require_mapping(
        summary.get("evidence"),
        field="run-summary.evidence",
    )
    evidence_path = _safe_relative_path(
        root,
        summary_evidence.get("path"),
        field="run-summary.evidence.path",
    )

    # The bundle verifier ran immediately above. Re-hash its three small control
    # files before trusting paths/identity from them so a concurrent replacement
    # cannot splice a new manifest/evidence file into this source audit.
    _require_equal(
        _canonical_sha256(
            bundle.get("runSummarySha256"),
            field="bundle.runSummarySha256",
        ),
        sha256_file(summary_path),
        field="bundle run-summary snapshot",
    )
    _require_equal(
        _canonical_sha256(
            bundle.get("manifestSha256"),
            field="bundle.manifestSha256",
        ),
        sha256_file(manifest_path),
        field="bundle manifest snapshot",
    )
    _require_equal(
        _canonical_sha256(
            bundle.get("evidenceSha256"),
            field="bundle.evidenceSha256",
        ),
        sha256_file(evidence_path),
        field="bundle evidence snapshot",
    )

    manifest = _json_object(manifest_path, field="split manifest")
    manifest_source = _require_mapping(
        manifest.get("sourceModel"),
        field="split-manifest.sourceModel",
    )
    expected_graph_sha = _canonical_sha256(
        manifest_source.get("sha256"),
        field="split-manifest.sourceModel.sha256",
    )
    graph_bytes, observed_graph_sha = _stable_identity(
        full_model,
        field="full model graph",
        hasher=file_hasher,
    )
    _require_equal(expected_graph_sha, observed_graph_sha, field="source graph SHA-256")
    _require_equal(
        expected_graph_sha,
        _canonical_sha256(
            bundle.get("sourceGraphSha256"),
            field="bundle.sourceGraphSha256",
        ),
        field="split manifest source graph vs capture bundle",
    )

    manifest_external = _normalized_external_entries(
        manifest_source.get("externalData"),
        field="split-manifest.sourceModel.externalData",
    )
    observed_external: list[dict[str, object]] = []
    for index, entry in enumerate(manifest_external):
        location = str(entry["location"])
        source_path = _safe_relative_path(
            full_model.parent,
            location,
            field=f"split-manifest.sourceModel.externalData[{index}].location",
        )
        observed_bytes, observed_sha = _stable_identity(
            source_path,
            field=f"source external data {location}",
            hasher=file_hasher,
        )
        _require_equal(
            entry["bytes"],
            observed_bytes,
            field=f"source external-data bytes for {location}",
        )
        _require_equal(
            entry["sha256"],
            observed_sha,
            field=f"source external-data SHA-256 for {location}",
        )
        observed_external.append(
            {"location": location, "bytes": observed_bytes, "sha256": observed_sha}
        )

    evidence = _json_object(evidence_path, field="same-machine evidence")
    verification = _require_mapping(
        evidence.get("verification"),
        field="evidence.verification",
    )
    verification_source = _require_mapping(
        verification.get("sourceModel"),
        field="evidence.verification.sourceModel",
    )
    if verification_source.get("allExternalDataHashed") is not True:
        raise ValueError("evidence.verification.sourceModel must hash all external data")
    _require_equal(
        expected_graph_sha,
        _canonical_sha256(
            verification_source.get("graphSha256"),
            field="evidence.verification.sourceModel.graphSha256",
        ),
        field="split manifest source graph vs embedded verification",
    )
    if "graphBytes" in verification_source:
        _require_equal(
            graph_bytes,
            _non_negative_int(
                verification_source.get("graphBytes"),
                field="evidence.verification.sourceModel.graphBytes",
            ),
            field="source graph bytes vs embedded verification",
        )
    verification_external = _normalized_external_entries(
        verification_source.get("externalData"),
        field="evidence.verification.sourceModel.externalData",
    )
    _require_equal(
        manifest_external,
        verification_external,
        field="split manifest source external data vs embedded verification",
    )

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "captureStatus": bundle.get("captureStatus"),
        "manifestSha256": bundle["manifestSha256"],
        "sourceGraphBytes": graph_bytes,
        "sourceGraphSha256": observed_graph_sha,
        "sourceExternalDataCount": len(observed_external),
        "sourceExternalDataBytes": sum(
            int(item["bytes"]) for item in observed_external
        ),
        "sourceExternalData": observed_external,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-dir", type=Path, required=True)
    parser.add_argument("--full-model", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = verify_capture_source(args.capture_dir, args.full_model)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
