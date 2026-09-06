#!/usr/bin/env python3
"""Run the complete post-publication audit for a #167 capture bundle.

Operators previously had to remember two independent commands:

* verify_multi_segment_capture_bundle.py — re-hash the published capture; and
* verify_multi_segment_capture_source.py — bind that capture to the original
  full ONNX graph and source external-data files.

This entrypoint intentionally runs both. The source audit already performs its
own bundle verification, so this command obtains two independently measured
bundle snapshots and refuses to publish a combined pass unless their immutable
identities agree. This makes an incomplete audit harder to perform accidentally
and also fails closed if the capture changes between the first bundle audit and
the source audit.

ONNX Runtime is not loaded by this tool.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from typing import Callable

from verify_multi_segment_capture_bundle import verify_capture_bundle
from verify_multi_segment_capture_source import verify_capture_source


REPORT_KIND = "unzen-budgeted-multi-segment-complete-capture-audit"
REPORT_SCHEMA_VERSION = "1.0.0"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _require_pass(raw: object, *, field: str) -> None:
    if raw != "pass":
        raise RuntimeError(f"{field} did not pass: {raw!r}")


def _canonical_sha256(raw: object, *, field: str) -> str:
    if not isinstance(raw, str) or not SHA256_RE.fullmatch(raw):
        raise ValueError(f"{field} must be a canonical lowercase SHA-256 digest")
    return raw


def _require_equal(left: object, right: object, *, field: str) -> None:
    if left != right:
        raise RuntimeError(f"{field} changed during complete audit: first={left!r}, second={right!r}")


def audit_capture(
    capture_dir: Path,
    full_model_path: Path,
    *,
    bundle_verifier: Callable[[Path], dict[str, object]] = verify_capture_bundle,
    source_verifier: Callable[[Path, Path], dict[str, object]] = verify_capture_source,
) -> dict[str, object]:
    """Verify the published bundle and bind it to its original source model."""

    capture = capture_dir.expanduser().absolute()
    full_model = full_model_path.expanduser().absolute()

    first_bundle = bundle_verifier(capture)
    _require_pass(first_bundle.get("status"), field="bundle verification")

    source = source_verifier(capture, full_model)
    _require_pass(source.get("status"), field="source verification")

    first_manifest = _canonical_sha256(
        first_bundle.get("manifestSha256"),
        field="bundle.manifestSha256",
    )
    source_manifest = _canonical_sha256(
        source.get("manifestSha256"),
        field="source.manifestSha256",
    )
    _require_equal(
        first_manifest,
        source_manifest,
        field="manifest SHA-256",
    )

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
        first_bundle.get("captureStatus"),
        source.get("captureStatus"),
        field="capture status",
    )

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "captureStatus": source.get("captureStatus"),
        "manifestSha256": source_manifest,
        "sourceGraphSha256": source_graph,
        "sourceGraphBytes": source.get("sourceGraphBytes"),
        "sourceExternalDataCount": source.get("sourceExternalDataCount"),
        "sourceExternalDataBytes": source.get("sourceExternalDataBytes"),
        "sourceExternalData": source.get("sourceExternalData"),
        "segmentCount": first_bundle.get("segmentCount"),
        "maximumSegmentArtifactBytes": first_bundle.get("maximumSegmentArtifactBytes"),
        "effectiveRequiredMaxBytes": first_bundle.get("effectiveRequiredMaxBytes"),
        "runSummarySha256": first_bundle.get("runSummarySha256"),
        "evidenceSha256": first_bundle.get("evidenceSha256"),
        "verificationSha256": first_bundle.get("verificationSha256"),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-dir", type=Path, required=True)
    parser.add_argument("--full-model", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = audit_capture(args.capture_dir, args.full_model)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
