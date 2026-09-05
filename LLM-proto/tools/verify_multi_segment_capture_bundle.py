#!/usr/bin/env python3
"""Verify a published #167 multi-segment capture bundle without ONNX Runtime.

The one-shot capture runner publishes three layers of evidence together:

* ``run-summary.json``;
* ``same-machine-evidence.json``;
* the generated split manifest and segment artifacts.

This verifier re-hashes those files after publication and checks that the
summary, evidence envelope, embedded numerical report, and measured artifact
preflight all refer to one identical snapshot. It intentionally depends only on
the Python standard library plus the existing stdlib-only artifact verifier, so
operators can audit a multi-gigabyte capture without loading ONNX Runtime or the
full model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re

from verify_multi_segment_artifacts import sha256_file, verify_artifact_integrity


RUN_KIND = "unzen-budgeted-multi-segment-capture-run"
RUN_SCHEMA_VERSION = "1.0.0"
EVIDENCE_KIND = "unzen-budgeted-multi-segment-evidence-bundle"
EVIDENCE_SCHEMA_VERSION = "1.0.0"
VERIFICATION_KIND = "unzen-budgeted-multi-segment-same-machine-verification"
VERIFICATION_SCHEMA_VERSION = "1.1.0"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def canonical_json_bytes(value: object) -> bytes:
    """Return the canonical encoding used for ``verificationSha256``."""

    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


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
        raise ValueError(f"{field} escapes capture directory: {value}")
    return resolved


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


def _canonical_sha256(raw: object, *, field: str) -> str:
    value = str(raw or "")
    if not SHA256_RE.fullmatch(value):
        raise ValueError(f"{field} must be a canonical lowercase SHA-256 digest")
    return value


def _positive_int(raw: object, *, field: str) -> int:
    # Published count/byte fields are immutable evidence, not permissive CLI
    # input. Reject floats, booleans, and numeric strings rather than normalizing
    # them with int(), because Python equality would otherwise let 2.0 == 2 pass.
    if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return raw


def _require_mapping(raw: object, *, field: str) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise ValueError(f"{field} must be an object")
    return raw


def _require_status(raw: object, *, field: str) -> str:
    value = str(raw or "")
    if value not in {"pass", "fail"}:
        raise ValueError(f"{field} must be 'pass' or 'fail'")
    return value


def _require_equal(left: object, right: object, *, field: str) -> None:
    if left != right:
        raise ValueError(f"{field} mismatch: expected={left!r}, observed={right!r}")


def _bind_artifact_identity(
    summary_artifacts: dict[str, object],
    integrity: dict[str, object],
    verification: dict[str, object],
) -> None:
    embedded_integrity = _require_mapping(
        verification.get("artifactIntegrity"),
        field="evidence.verification.artifactIntegrity",
    )
    if embedded_integrity.get("status") != "pass":
        raise ValueError("evidence.verification.artifactIntegrity must have status='pass'")

    summary_manifest_sha = _canonical_sha256(
        summary_artifacts.get("manifestSha256"),
        field="run-summary.artifacts.manifestSha256",
    )
    measured_manifest_sha = _canonical_sha256(
        integrity.get("manifestSha256"),
        field="measured integrity.manifestSha256",
    )
    embedded_manifest_sha = _canonical_sha256(
        embedded_integrity.get("manifestSha256"),
        field="evidence.verification.artifactIntegrity.manifestSha256",
    )
    _require_equal(
        summary_manifest_sha,
        measured_manifest_sha,
        field="run-summary.artifacts.manifestSha256 vs measured integrity",
    )
    _require_equal(
        measured_manifest_sha,
        embedded_manifest_sha,
        field="measured integrity.manifestSha256 vs embedded verification",
    )

    for field in (
        "segmentCount",
        "maximumSegmentArtifactBytes",
        "effectiveRequiredMaxBytes",
    ):
        summary_value = _positive_int(
            summary_artifacts.get(field),
            field=f"run-summary.artifacts.{field}",
        )
        measured_value = _positive_int(
            integrity.get(field),
            field=f"measured integrity.{field}",
        )
        embedded_value = _positive_int(
            embedded_integrity.get(field),
            field=f"evidence.verification.artifactIntegrity.{field}",
        )
        _require_equal(
            summary_value,
            measured_value,
            field=f"run-summary.artifacts.{field} vs measured integrity",
        )
        _require_equal(
            measured_value,
            embedded_value,
            field=f"measured integrity.{field} vs embedded verification",
        )


def _bind_run_parameters(
    summary_parameters: dict[str, object],
    evidence_parameters: dict[str, object],
    verification: dict[str, object],
) -> None:
    for field in ("provider", "inputTokenIds", "kvHeads", "headSize", "atol", "rtol"):
        _require_equal(
            summary_parameters.get(field),
            evidence_parameters.get(field),
            field=f"run-summary.parameters.{field} vs evidence.parameters",
        )

    _require_equal(
        summary_parameters.get("provider"),
        verification.get("provider"),
        field="run-summary.parameters.provider vs verification.provider",
    )
    _require_equal(
        summary_parameters.get("inputTokenIds"),
        verification.get("inputTokenIds"),
        field="run-summary.parameters.inputTokenIds vs verification.inputTokenIds",
    )


def verify_capture_bundle(capture_dir: Path) -> dict[str, object]:
    """Re-measure and cross-bind every published capture evidence layer."""

    root = capture_dir.expanduser().absolute()
    if not root.is_dir():
        raise NotADirectoryError(f"capture directory not found: {root}")

    summary_path = root / "run-summary.json"
    summary = _json_object(summary_path, field="run summary")
    if summary.get("schemaVersion") != RUN_SCHEMA_VERSION:
        raise ValueError(
            f"unexpected run-summary schemaVersion: {summary.get('schemaVersion')!r}"
        )
    if summary.get("kind") != RUN_KIND:
        raise ValueError(f"unexpected run-summary kind: {summary.get('kind')!r}")
    status = _require_status(summary.get("status"), field="run-summary.status")

    source_model = _require_mapping(
        summary.get("sourceModel"),
        field="run-summary.sourceModel",
    )
    source_graph_sha256 = _canonical_sha256(
        source_model.get("graphSha256"),
        field="run-summary.sourceModel.graphSha256",
    )

    summary_artifacts = _require_mapping(
        summary.get("artifacts"),
        field="run-summary.artifacts",
    )
    manifest_path = _safe_relative_path(
        root,
        summary_artifacts.get("manifest"),
        field="run-summary.artifacts.manifest",
    )
    integrity = verify_artifact_integrity(manifest_path)
    if integrity.get("status") != "pass":
        raise RuntimeError("measured artifact integrity did not pass")

    summary_evidence = _require_mapping(
        summary.get("evidence"),
        field="run-summary.evidence",
    )
    evidence_path = _safe_relative_path(
        root,
        summary_evidence.get("path"),
        field="run-summary.evidence.path",
    )
    expected_evidence_sha = _canonical_sha256(
        summary_evidence.get("sha256"),
        field="run-summary.evidence.sha256",
    )
    observed_evidence_sha = sha256_file(evidence_path)
    if observed_evidence_sha != expected_evidence_sha:
        raise ValueError(
            "same-machine evidence SHA-256 mismatch: "
            f"expected={expected_evidence_sha}, observed={observed_evidence_sha}"
        )

    evidence = _json_object(evidence_path, field="same-machine evidence")
    if evidence.get("schemaVersion") != EVIDENCE_SCHEMA_VERSION:
        raise ValueError(
            f"unexpected evidence schemaVersion: {evidence.get('schemaVersion')!r}"
        )
    if evidence.get("kind") != EVIDENCE_KIND:
        raise ValueError(f"unexpected evidence kind: {evidence.get('kind')!r}")
    evidence_status = _require_status(
        evidence.get("status"),
        field="evidence.status",
    )
    _require_equal(status, evidence_status, field="run-summary.status vs evidence.status")

    verification = _require_mapping(
        evidence.get("verification"),
        field="evidence.verification",
    )
    if verification.get("schemaVersion") != VERIFICATION_SCHEMA_VERSION:
        raise ValueError(
            "unexpected embedded verification schemaVersion: "
            f"{verification.get('schemaVersion')!r}"
        )
    if verification.get("kind") != VERIFICATION_KIND:
        raise ValueError(
            f"unexpected embedded verification kind: {verification.get('kind')!r}"
        )
    verification_status = _require_status(
        verification.get("status"),
        field="evidence.verification.status",
    )
    _require_equal(
        status,
        verification_status,
        field="run-summary.status vs verification.status",
    )

    expected_verification_sha = _canonical_sha256(
        evidence.get("verificationSha256"),
        field="evidence.verificationSha256",
    )
    observed_verification_sha = hashlib.sha256(
        canonical_json_bytes(verification)
    ).hexdigest()
    if observed_verification_sha != expected_verification_sha:
        raise ValueError(
            "embedded verification SHA-256 mismatch: "
            f"expected={expected_verification_sha}, observed={observed_verification_sha}"
        )
    _require_equal(
        _canonical_sha256(
            summary_evidence.get("verificationSha256"),
            field="run-summary.evidence.verificationSha256",
        ),
        expected_verification_sha,
        field="run-summary verification digest vs evidence verification digest",
    )

    _bind_artifact_identity(summary_artifacts, integrity, verification)

    verification_source = _require_mapping(
        verification.get("sourceModel"),
        field="evidence.verification.sourceModel",
    )
    _require_equal(
        source_graph_sha256,
        _canonical_sha256(
            verification_source.get("graphSha256"),
            field="evidence.verification.sourceModel.graphSha256",
        ),
        field="run-summary source graph vs verification source graph",
    )

    summary_parameters = _require_mapping(
        summary.get("parameters"),
        field="run-summary.parameters",
    )
    evidence_parameters = _require_mapping(
        evidence.get("parameters"),
        field="evidence.parameters",
    )
    _bind_run_parameters(summary_parameters, evidence_parameters, verification)

    return {
        "schemaVersion": "1.0.0",
        "kind": "unzen-budgeted-multi-segment-capture-bundle-verification",
        "status": "pass",
        "captureStatus": status,
        "runSummarySha256": sha256_file(summary_path),
        "evidenceSha256": observed_evidence_sha,
        "verificationSha256": observed_verification_sha,
        "manifestSha256": integrity["manifestSha256"],
        "segmentCount": _positive_int(
            integrity.get("segmentCount"),
            field="measured integrity.segmentCount",
        ),
        "maximumSegmentArtifactBytes": _positive_int(
            integrity.get("maximumSegmentArtifactBytes"),
            field="measured integrity.maximumSegmentArtifactBytes",
        ),
        "effectiveRequiredMaxBytes": _positive_int(
            integrity.get("effectiveRequiredMaxBytes"),
            field="measured integrity.effectiveRequiredMaxBytes",
        ),
        "sourceGraphSha256": source_graph_sha256,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-dir", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = verify_capture_bundle(args.capture_dir)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
