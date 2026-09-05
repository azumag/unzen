#!/usr/bin/env python3
"""Capture one complete #167 host-side multi-segment evidence run.

This command intentionally performs the real 1B host-side path in one bounded
operation:

1. generate browser-budgeted ONNX shards with source external-data hashing on;
2. re-measure the generated artifacts with the stdlib-only integrity preflight;
3. run the provenance-rich full-vs-multi numerical evidence collector;
4. publish the split artifacts, evidence JSON, and a compact run summary together.

Generation happens in a sibling staging directory. Tooling/preflight failures
remove the staging directory and leave the requested destination untouched.
A numerical mismatch is different: it is useful evidence, so the completed run
is published with status=fail and the CLI exits non-zero.

The runner never downloads a model and never relaxes the product browser
artifact ceiling. The operator must provide an already-downloaded source ONNX
model and its external-data files.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
from typing import Sequence

from collect_multi_segment_evidence import collect_evidence, write_evidence
from multi_segment_onnx import PREFERRED_MAX_BYTES, prepare_budgeted_multi_split
from verify_multi_segment_artifacts import verify_artifact_integrity
from verify_split_onnx import parse_token_ids


RUN_KIND = "unzen-budgeted-multi-segment-capture-run"
RUN_SCHEMA_VERSION = "1.0.0"
DEFAULT_TARGET_BYTES = 200 * 1024 * 1024


def ensure_destination_available(path: Path) -> Path:
    """Reject an occupied destination before any model or ONNX Runtime work."""

    destination = path.expanduser().absolute()
    if os.path.lexists(destination):
        raise FileExistsError(f"capture destination already exists: {destination}")
    parent = destination.parent
    if parent.exists() and not parent.is_dir():
        raise NotADirectoryError(f"capture destination parent is not a directory: {parent}")
    return destination


def _make_staging_dir(destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    while True:
        candidate = destination.parent / (
            f".{destination.name}.{os.getpid()}.{secrets.token_hex(6)}.tmp"
        )
        try:
            candidate.mkdir()
        except FileExistsError:
            continue
        return candidate


def _require_integrity_pass(report: object) -> dict[str, object]:
    if not isinstance(report, dict):
        raise ValueError("artifact-integrity preflight must return an object")
    if report.get("status") != "pass":
        raise RuntimeError(
            "artifact-integrity preflight did not pass; refusing numerical capture"
        )
    if not isinstance(report.get("manifestSha256"), str):
        raise ValueError("artifact-integrity preflight is missing manifestSha256")
    if not isinstance(report.get("segmentCount"), int) or report["segmentCount"] <= 0:
        raise ValueError("artifact-integrity preflight has invalid segmentCount")
    if (
        not isinstance(report.get("maximumSegmentArtifactBytes"), int)
        or report["maximumSegmentArtifactBytes"] <= 0
    ):
        raise ValueError(
            "artifact-integrity preflight has invalid maximumSegmentArtifactBytes"
        )
    if (
        not isinstance(report.get("effectiveRequiredMaxBytes"), int)
        or report["effectiveRequiredMaxBytes"] <= 0
    ):
        raise ValueError(
            "artifact-integrity preflight has invalid effectiveRequiredMaxBytes"
        )
    return report


def capture_run(
    full_model_path: Path,
    destination: Path,
    token_ids: Sequence[int],
    *,
    hidden_size: int = 2048,
    target_bytes: int = DEFAULT_TARGET_BYTES,
    preferred_max_bytes: int = PREFERRED_MAX_BYTES,
    provider: str = "CPUExecutionProvider",
    kv_heads: int = 8,
    head_size: int = 64,
    atol: float = 1e-4,
    rtol: float = 1e-4,
) -> dict[str, object]:
    """Generate, preflight, verify, and publish one complete capture bundle."""

    output_root = ensure_destination_available(destination)
    staging = _make_staging_dir(output_root)
    published = False
    try:
        split_dir = staging / "split"
        prepare_budgeted_multi_split(
            full_model_path,
            split_dir,
            hidden_size=hidden_size,
            target_bytes=target_bytes,
            preferred_max_bytes=preferred_max_bytes,
            # Numerical evidence requires cryptographic binding to every source
            # external-data file. Do not expose the generator's skip-digest mode.
            hash_source_external_data=True,
        )

        manifest_path = split_dir / "split-manifest.json"
        integrity = _require_integrity_pass(
            verify_artifact_integrity(manifest_path)
        )

        evidence = collect_evidence(
            full_model_path,
            manifest_path,
            token_ids,
            provider=provider,
            kv_heads=kv_heads,
            head_size=head_size,
            atol=atol,
            rtol=rtol,
        )
        status = evidence.get("status")
        if status not in {"pass", "fail"}:
            raise ValueError(
                f"same-machine evidence returned unsupported status: {status!r}"
            )

        evidence_path = staging / "same-machine-evidence.json"
        evidence_sha = write_evidence(evidence_path, evidence)
        summary: dict[str, object] = {
            "schemaVersion": RUN_SCHEMA_VERSION,
            "kind": RUN_KIND,
            "status": status,
            "parameters": {
                "hiddenSize": hidden_size,
                "targetBytes": target_bytes,
                "preferredMaxBytes": preferred_max_bytes,
                "provider": provider,
                "inputTokenIds": list(token_ids),
                "kvHeads": kv_heads,
                "headSize": head_size,
                "atol": atol,
                "rtol": rtol,
            },
            "artifacts": {
                "manifest": "split/split-manifest.json",
                "manifestSha256": integrity["manifestSha256"],
                "segmentCount": integrity["segmentCount"],
                "maximumSegmentArtifactBytes": integrity[
                    "maximumSegmentArtifactBytes"
                ],
                "effectiveRequiredMaxBytes": integrity[
                    "effectiveRequiredMaxBytes"
                ],
            },
            "evidence": {
                "path": "same-machine-evidence.json",
                "sha256": evidence_sha,
                "verificationSha256": evidence.get("verificationSha256"),
            },
        }
        write_evidence(staging / "run-summary.json", summary)

        # Re-check just before publication. The staging directory is a sibling,
        # so the final rename stays on one filesystem and does not expose a
        # half-copied multi-gigabyte artifact set.
        if os.path.lexists(output_root):
            raise FileExistsError(
                f"capture destination appeared during run: {output_root}"
            )
        staging.rename(output_root)
        published = True
        return summary
    finally:
        if not published:
            shutil.rmtree(staging, ignore_errors=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full-model", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--input-ids", required=True, help="Comma-separated token IDs")
    parser.add_argument("--hidden-size", type=int, default=2048)
    parser.add_argument("--target-bytes", type=int, default=DEFAULT_TARGET_BYTES)
    parser.add_argument(
        "--preferred-max-bytes",
        type=int,
        default=PREFERRED_MAX_BYTES,
    )
    parser.add_argument("--provider", default="CPUExecutionProvider")
    parser.add_argument("--kv-heads", type=int, default=8)
    parser.add_argument("--head-size", type=int, default=64)
    parser.add_argument("--atol", type=float, default=1e-4)
    parser.add_argument("--rtol", type=float, default=1e-4)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    output_dir = ensure_destination_available(args.output_dir)
    summary = capture_run(
        args.full_model,
        output_dir,
        parse_token_ids(args.input_ids),
        hidden_size=args.hidden_size,
        target_bytes=args.target_bytes,
        preferred_max_bytes=args.preferred_max_bytes,
        provider=args.provider,
        kv_heads=args.kv_heads,
        head_size=args.head_size,
        atol=args.atol,
        rtol=args.rtol,
    )
    print(
        json.dumps(
            {
                "status": summary["status"],
                "outputDir": str(output_dir),
                "manifestSha256": summary["artifacts"]["manifestSha256"],
                "evidenceSha256": summary["evidence"]["sha256"],
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0 if summary["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
