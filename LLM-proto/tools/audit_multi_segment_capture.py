#!/usr/bin/env python3
"""Run the complete post-publication audit for a #167 capture bundle.

Operators previously had to remember two independent commands:

* verify_multi_segment_capture_bundle.py — re-hash the published capture; and
* verify_multi_segment_capture_source.py — bind that capture to the original
  full ONNX graph and source external-data files.

This entrypoint intentionally runs both. The source audit already performs its
own bundle verification, so this command obtains independently measured bundle
and source snapshots before, during, and after verification and refuses to
publish a combined pass unless their immutable identities agree. This makes an
incomplete audit harder to perform accidentally and also fails closed if either
the capture or its original source artifacts change at any observed point during
the complete audit.

ONNX Runtime is not loaded by this tool.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
from typing import Callable

from verify_multi_segment_artifact_snapshot import (
    PATH_RESOLUTION_COMPONENT_ANCHORED,
    PATH_RESOLUTION_FINAL_ONLY,
)
from verify_multi_segment_capture_bundle import verify_capture_bundle
from verify_multi_segment_capture_source import verify_capture_source


REPORT_KIND = "unzen-budgeted-multi-segment-complete-capture-audit"
REPORT_SCHEMA_VERSION = "1.0.0"
BUNDLE_REPORT_KIND = "unzen-budgeted-multi-segment-capture-bundle-verification"
BUNDLE_REPORT_SCHEMA_VERSION = "1.1.0"
SOURCE_REPORT_KIND = "unzen-budgeted-multi-segment-capture-source-verification"
SOURCE_REPORT_SCHEMA_VERSION = "1.0.0"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CAPTURE_STATUSES = frozenset({"pass", "fail"})
PATH_RESOLUTION_MODES = frozenset(
    {
        PATH_RESOLUTION_COMPONENT_ANCHORED,
        PATH_RESOLUTION_FINAL_ONLY,
    }
)
STRONG_PATH_RESOLUTION_MODE = PATH_RESOLUTION_COMPONENT_ANCHORED


def _require_pass(raw: object, *, field: str) -> None:
    if raw != "pass":
        raise RuntimeError(f"{field} did not pass: {raw!r}")


def _require_report_contract(
    report: dict[str, object],
    *,
    field: str,
    expected_kind: str,
    expected_schema_version: str,
) -> None:
    kind = report.get("kind")
    if kind != expected_kind:
        raise ValueError(
            f"{field}.kind must be {expected_kind!r}: {kind!r}"
        )
    schema_version = report.get("schemaVersion")
    if schema_version != expected_schema_version:
        raise ValueError(
            f"{field}.schemaVersion must be {expected_schema_version!r}: "
            f"{schema_version!r}"
        )


def _require_mapping(raw: object, *, field: str) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise ValueError(f"{field} must be an object")
    return raw


def _non_empty_string(raw: object, *, field: str) -> str:
    if not isinstance(raw, str) or not raw:
        raise ValueError(f"{field} must be a non-empty string")
    return raw


def _canonical_sha256(raw: object, *, field: str) -> str:
    if not isinstance(raw, str) or not SHA256_RE.fullmatch(raw):
        raise ValueError(f"{field} must be a canonical lowercase SHA-256 digest")
    return raw


def _non_negative_int(raw: object, *, field: str) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return raw


def _positive_int(raw: object, *, field: str) -> int:
    value = _non_negative_int(raw, field=field)
    if value == 0:
        raise ValueError(f"{field} must be a positive integer")
    return value


def _capture_status(raw: object, *, field: str) -> str:
    if not isinstance(raw, str) or raw not in CAPTURE_STATUSES:
        expected = ", ".join(sorted(CAPTURE_STATUSES))
        raise ValueError(f"{field} must be one of: {expected}")
    return raw


def _source_external_data(raw: object, *, field: str) -> list[dict[str, object]]:
    if not isinstance(raw, list):
        raise ValueError(f"{field} must be an array")

    entries: list[dict[str, object]] = []
    seen_locations: set[str] = set()
    for index, raw_entry in enumerate(raw):
        prefix = f"{field}[{index}]"
        entry = _require_mapping(raw_entry, field=prefix)
        location = _non_empty_string(entry.get("location"), field=f"{prefix}.location")
        posix = PurePosixPath(location)
        windows = PureWindowsPath(location)
        if (
            posix.is_absolute()
            or windows.is_absolute()
            or bool(windows.drive)
            or ".." in posix.parts
            or ".." in windows.parts
        ):
            raise ValueError(f"unsafe {prefix}.location: {location}")
        if location in seen_locations:
            raise ValueError(f"duplicate external-data location in {field}: {location}")
        seen_locations.add(location)
        entries.append(
            {
                "location": location,
                "bytes": _non_negative_int(entry.get("bytes"), field=f"{prefix}.bytes"),
                "sha256": _canonical_sha256(entry.get("sha256"), field=f"{prefix}.sha256"),
            }
        )
    return entries


def _path_resolution_mode(raw: object, *, field: str) -> str:
    if not isinstance(raw, str) or raw not in PATH_RESOLUTION_MODES:
        expected = ", ".join(sorted(PATH_RESOLUTION_MODES))
        raise ValueError(f"{field} must be one of: {expected}")
    return raw


def _optional_path_resolution_mode(raw: object, *, field: str) -> str | None:
    if raw is None:
        return None
    return _path_resolution_mode(raw, field=field)


def _require_strong_path_resolution(mode: str, *, field: str) -> None:
    if mode != STRONG_PATH_RESOLUTION_MODE:
        raise RuntimeError(
            f"{field} did not use {STRONG_PATH_RESOLUTION_MODE} path resolution: {mode!r}"
        )


def _require_equal(left: object, right: object, *, field: str) -> None:
    if left != right:
        raise RuntimeError(f"{field} changed during complete audit: first={left!r}, second={right!r}")


def audit_capture(
    capture_dir: Path,
    full_model_path: Path,
    *,
    require_component_anchored_source: bool = False,
    require_component_anchored_artifacts: bool = False,
    bundle_verifier: Callable[[Path], dict[str, object]] = verify_capture_bundle,
    source_verifier: Callable[[Path, Path], dict[str, object]] = verify_capture_source,
) -> dict[str, object]:
    """Verify the published bundle and bind it to its original source model."""

    capture = capture_dir.expanduser().absolute()
    full_model = full_model_path.expanduser().absolute()

    first_bundle = bundle_verifier(capture)
    _require_report_contract(
        first_bundle,
        field="bundle",
        expected_kind=BUNDLE_REPORT_KIND,
        expected_schema_version=BUNDLE_REPORT_SCHEMA_VERSION,
    )
    _require_pass(first_bundle.get("status"), field="bundle verification")

    capture_status = _capture_status(
        first_bundle.get("captureStatus"),
        field="bundle.captureStatus",
    )
    segment_count = _positive_int(
        first_bundle.get("segmentCount"),
        field="bundle.segmentCount",
    )
    maximum_segment_artifact_bytes = _positive_int(
        first_bundle.get("maximumSegmentArtifactBytes"),
        field="bundle.maximumSegmentArtifactBytes",
    )
    effective_required_max_bytes = _positive_int(
        first_bundle.get("effectiveRequiredMaxBytes"),
        field="bundle.effectiveRequiredMaxBytes",
    )

    if "captureSnapshotPathResolutionMode" not in first_bundle:
        raise ValueError(
            "bundle.captureSnapshotPathResolutionMode must be present; "
            "legacy capture-time mode must be represented explicitly as null"
        )
    capture_snapshot_path_resolution_mode = _optional_path_resolution_mode(
        first_bundle.get("captureSnapshotPathResolutionMode"),
        field="bundle.captureSnapshotPathResolutionMode",
    )
    audit_snapshot_path_resolution_mode = _path_resolution_mode(
        first_bundle.get("auditSnapshotPathResolutionMode"),
        field="bundle.auditSnapshotPathResolutionMode",
    )
    if require_component_anchored_artifacts:
        _require_strong_path_resolution(
            audit_snapshot_path_resolution_mode,
            field="artifact snapshot verification",
        )

    source = source_verifier(capture, full_model)
    _require_report_contract(
        source,
        field="source",
        expected_kind=SOURCE_REPORT_KIND,
        expected_schema_version=SOURCE_REPORT_SCHEMA_VERSION,
    )
    _require_pass(source.get("status"), field="source verification")

    source_capture_status = _capture_status(
        source.get("captureStatus"),
        field="source.captureStatus",
    )
    source_graph_bytes = _non_negative_int(
        source.get("sourceGraphBytes"),
        field="source.sourceGraphBytes",
    )
    source_external_data = _source_external_data(
        source.get("sourceExternalData"),
        field="source.sourceExternalData",
    )
    source_external_data_count = _non_negative_int(
        source.get("sourceExternalDataCount"),
        field="source.sourceExternalDataCount",
    )
    source_external_data_bytes = _non_negative_int(
        source.get("sourceExternalDataBytes"),
        field="source.sourceExternalDataBytes",
    )
    if source_external_data_count != len(source_external_data):
        raise ValueError(
            "source.sourceExternalDataCount must equal the number of "
            f"source.sourceExternalData entries: count={source_external_data_count}, "
            f"entries={len(source_external_data)}"
        )
    measured_external_data_bytes = sum(int(item["bytes"]) for item in source_external_data)
    if source_external_data_bytes != measured_external_data_bytes:
        raise ValueError(
            "source.sourceExternalDataBytes must equal the sum of "
            f"source.sourceExternalData bytes: total={source_external_data_bytes}, "
            f"entries={measured_external_data_bytes}"
        )

    source_path_resolution_mode = _path_resolution_mode(
        source.get("sourcePathResolutionMode"),
        field="source.sourcePathResolutionMode",
    )
    if require_component_anchored_source:
        _require_strong_path_resolution(
            source_path_resolution_mode,
            field="source verification",
        )

    snapshot_digests: dict[str, str] = {}
    for key, label in (
        ("runSummarySha256", "run-summary SHA-256"),
        ("manifestSha256", "manifest SHA-256"),
        ("evidenceSha256", "evidence SHA-256"),
        ("verificationSha256", "verification SHA-256"),
    ):
        first_digest = _canonical_sha256(
            first_bundle.get(key),
            field=f"bundle.{key}",
        )
        source_digest = _canonical_sha256(
            source.get(key),
            field=f"source.{key}",
        )
        _require_equal(first_digest, source_digest, field=label)
        snapshot_digests[key] = first_digest

    first_source_graph = _canonical_sha256(
        first_bundle.get("sourceGraphSha256"),
        field="bundle.sourceGraphSha256",
    )
    source_graph = _canonical_sha256(
        source.get("sourceGraphSha256"),
        field="source.sourceGraphSha256",
    )
    _require_equal(
        first_source_graph,
        source_graph,
        field="source graph SHA-256",
    )

    _require_equal(
        capture_status,
        source_capture_status,
        field="capture status",
    )

    final_bundle = bundle_verifier(capture)
    _require_report_contract(
        final_bundle,
        field="post-source bundle",
        expected_kind=BUNDLE_REPORT_KIND,
        expected_schema_version=BUNDLE_REPORT_SCHEMA_VERSION,
    )
    _require_pass(
        final_bundle.get("status"),
        field="post-source bundle verification",
    )

    final_capture_status = _capture_status(
        final_bundle.get("captureStatus"),
        field="post-source bundle.captureStatus",
    )
    final_segment_count = _positive_int(
        final_bundle.get("segmentCount"),
        field="post-source bundle.segmentCount",
    )
    final_maximum_segment_artifact_bytes = _positive_int(
        final_bundle.get("maximumSegmentArtifactBytes"),
        field="post-source bundle.maximumSegmentArtifactBytes",
    )
    final_effective_required_max_bytes = _positive_int(
        final_bundle.get("effectiveRequiredMaxBytes"),
        field="post-source bundle.effectiveRequiredMaxBytes",
    )

    if "captureSnapshotPathResolutionMode" not in final_bundle:
        raise ValueError(
            "post-source bundle.captureSnapshotPathResolutionMode must be present; "
            "legacy capture-time mode must be represented explicitly as null"
        )
    final_capture_snapshot_path_resolution_mode = _optional_path_resolution_mode(
        final_bundle.get("captureSnapshotPathResolutionMode"),
        field="post-source bundle.captureSnapshotPathResolutionMode",
    )
    final_audit_snapshot_path_resolution_mode = _path_resolution_mode(
        final_bundle.get("auditSnapshotPathResolutionMode"),
        field="post-source bundle.auditSnapshotPathResolutionMode",
    )
    if require_component_anchored_artifacts:
        _require_strong_path_resolution(
            final_audit_snapshot_path_resolution_mode,
            field="post-source artifact snapshot verification",
        )

    for key, label in (
        ("runSummarySha256", "run-summary SHA-256 after source audit"),
        ("manifestSha256", "manifest SHA-256 after source audit"),
        ("evidenceSha256", "evidence SHA-256 after source audit"),
        ("verificationSha256", "verification SHA-256 after source audit"),
    ):
        final_digest = _canonical_sha256(
            final_bundle.get(key),
            field=f"post-source bundle.{key}",
        )
        _require_equal(snapshot_digests[key], final_digest, field=label)

    final_source_graph = _canonical_sha256(
        final_bundle.get("sourceGraphSha256"),
        field="post-source bundle.sourceGraphSha256",
    )
    _require_equal(
        source_graph,
        final_source_graph,
        field="source graph SHA-256 after source audit",
    )
    _require_equal(
        capture_status,
        final_capture_status,
        field="capture status after source audit",
    )
    _require_equal(
        segment_count,
        final_segment_count,
        field="segment count after source audit",
    )
    _require_equal(
        maximum_segment_artifact_bytes,
        final_maximum_segment_artifact_bytes,
        field="maximum segment artifact bytes after source audit",
    )
    _require_equal(
        effective_required_max_bytes,
        final_effective_required_max_bytes,
        field="effective required max bytes after source audit",
    )
    _require_equal(
        capture_snapshot_path_resolution_mode,
        final_capture_snapshot_path_resolution_mode,
        field="capture snapshot path-resolution mode after source audit",
    )
    _require_equal(
        audit_snapshot_path_resolution_mode,
        final_audit_snapshot_path_resolution_mode,
        field="artifact audit path-resolution mode after source audit",
    )

    postflight_source = source_verifier(capture, full_model)
    _require_report_contract(
        postflight_source,
        field="post-bundle source",
        expected_kind=SOURCE_REPORT_KIND,
        expected_schema_version=SOURCE_REPORT_SCHEMA_VERSION,
    )
    _require_pass(
        postflight_source.get("status"),
        field="post-bundle source verification",
    )

    postflight_source_capture_status = _capture_status(
        postflight_source.get("captureStatus"),
        field="post-bundle source.captureStatus",
    )
    postflight_source_graph_bytes = _non_negative_int(
        postflight_source.get("sourceGraphBytes"),
        field="post-bundle source.sourceGraphBytes",
    )
    postflight_source_external_data = _source_external_data(
        postflight_source.get("sourceExternalData"),
        field="post-bundle source.sourceExternalData",
    )
    postflight_source_external_data_count = _non_negative_int(
        postflight_source.get("sourceExternalDataCount"),
        field="post-bundle source.sourceExternalDataCount",
    )
    postflight_source_external_data_bytes = _non_negative_int(
        postflight_source.get("sourceExternalDataBytes"),
        field="post-bundle source.sourceExternalDataBytes",
    )
    if postflight_source_external_data_count != len(postflight_source_external_data):
        raise ValueError(
            "post-bundle source.sourceExternalDataCount must equal the number of "
            "post-bundle source.sourceExternalData entries: "
            f"count={postflight_source_external_data_count}, "
            f"entries={len(postflight_source_external_data)}"
        )
    postflight_measured_external_data_bytes = sum(
        int(item["bytes"]) for item in postflight_source_external_data
    )
    if postflight_source_external_data_bytes != postflight_measured_external_data_bytes:
        raise ValueError(
            "post-bundle source.sourceExternalDataBytes must equal the sum of "
            "post-bundle source.sourceExternalData bytes: "
            f"total={postflight_source_external_data_bytes}, "
            f"entries={postflight_measured_external_data_bytes}"
        )

    postflight_source_path_resolution_mode = _path_resolution_mode(
        postflight_source.get("sourcePathResolutionMode"),
        field="post-bundle source.sourcePathResolutionMode",
    )
    if require_component_anchored_source:
        _require_strong_path_resolution(
            postflight_source_path_resolution_mode,
            field="post-bundle source verification",
        )

    for key, label in (
        ("runSummarySha256", "run-summary SHA-256 after bundle postflight"),
        ("manifestSha256", "manifest SHA-256 after bundle postflight"),
        ("evidenceSha256", "evidence SHA-256 after bundle postflight"),
        ("verificationSha256", "verification SHA-256 after bundle postflight"),
    ):
        postflight_source_digest = _canonical_sha256(
            postflight_source.get(key),
            field=f"post-bundle source.{key}",
        )
        _require_equal(snapshot_digests[key], postflight_source_digest, field=label)

    postflight_source_graph = _canonical_sha256(
        postflight_source.get("sourceGraphSha256"),
        field="post-bundle source.sourceGraphSha256",
    )
    _require_equal(
        source_graph,
        postflight_source_graph,
        field="source graph SHA-256 after bundle postflight",
    )
    _require_equal(
        source_graph_bytes,
        postflight_source_graph_bytes,
        field="source graph bytes after bundle postflight",
    )
    _require_equal(
        source_external_data,
        postflight_source_external_data,
        field="source external data after bundle postflight",
    )
    _require_equal(
        source_external_data_count,
        postflight_source_external_data_count,
        field="source external-data count after bundle postflight",
    )
    _require_equal(
        source_external_data_bytes,
        postflight_source_external_data_bytes,
        field="source external-data bytes after bundle postflight",
    )
    _require_equal(
        source_path_resolution_mode,
        postflight_source_path_resolution_mode,
        field="source path-resolution mode after bundle postflight",
    )
    _require_equal(
        source_capture_status,
        postflight_source_capture_status,
        field="capture status after bundle postflight",
    )

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "captureStatus": source_capture_status,
        "bundleVerificationKind": BUNDLE_REPORT_KIND,
        "bundleVerificationSchemaVersion": BUNDLE_REPORT_SCHEMA_VERSION,
        "sourceVerificationKind": SOURCE_REPORT_KIND,
        "sourceVerificationSchemaVersion": SOURCE_REPORT_SCHEMA_VERSION,
        "manifestSha256": snapshot_digests["manifestSha256"],
        "captureSnapshotPathResolutionMode": capture_snapshot_path_resolution_mode,
        "auditSnapshotPathResolutionMode": audit_snapshot_path_resolution_mode,
        "sourceGraphSha256": source_graph,
        "sourcePathResolutionMode": source_path_resolution_mode,
        "sourceGraphBytes": source_graph_bytes,
        "sourceExternalDataCount": source_external_data_count,
        "sourceExternalDataBytes": source_external_data_bytes,
        "sourceExternalData": source_external_data,
        "segmentCount": segment_count,
        "maximumSegmentArtifactBytes": maximum_segment_artifact_bytes,
        "effectiveRequiredMaxBytes": effective_required_max_bytes,
        "runSummarySha256": snapshot_digests["runSummarySha256"],
        "evidenceSha256": snapshot_digests["evidenceSha256"],
        "verificationSha256": snapshot_digests["verificationSha256"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-dir", type=Path, required=True)
    parser.add_argument("--full-model", type=Path, required=True)
    parser.add_argument(
        "--require-component-anchored-source",
        action="store_true",
        help=(
            "fail unless the source audit used component-anchored-dirfd path "
            "resolution instead of the portable final-component-only fallback"
        ),
    )
    parser.add_argument(
        "--require-component-anchored-artifacts",
        action="store_true",
        help=(
            "fail unless the post-publication artifact snapshot audit used "
            "component-anchored-dirfd path resolution instead of the portable "
            "final-component-only fallback"
        ),
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = audit_capture(
        args.capture_dir,
        args.full_model,
        require_component_anchored_source=args.require_component_anchored_source,
        require_component_anchored_artifacts=args.require_component_anchored_artifacts,
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
