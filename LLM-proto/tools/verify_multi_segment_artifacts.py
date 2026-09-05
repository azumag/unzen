#!/usr/bin/env python3
"""Verify generated multi-segment artifacts before numerical or browser execution.

This preflight is intentionally stdlib-only. It validates the immutable evidence
record produced by ``multi_segment_onnx.py`` without loading ONNX Runtime or a
1B-class model into memory. Stale, modified, truncated, or over-budget segment
artifacts therefore fail before any expensive inference session is created.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path, PurePosixPath, PureWindowsPath


MANIFEST_KIND = "unzen-budgeted-multi-segment-onnx"
ARTIFACT_LAYOUT = "per-segment-external-data"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def sha256_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


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
        raise ValueError(f"{field} escapes split manifest directory: {value}")
    return resolved


def _canonical_sha256(raw: object, *, field: str) -> str:
    value = str(raw or "")
    if not SHA256_RE.fullmatch(value):
        raise ValueError(f"{field} must be a canonical lowercase SHA-256 digest")
    return value


def _positive_int(raw: object, *, field: str) -> int:
    if isinstance(raw, bool):
        raise ValueError(f"{field} must be a positive integer")
    try:
        value = int(raw)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be a positive integer") from error
    if value <= 0:
        raise ValueError(f"{field} must be a positive integer")
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


def _tier(byte_size: int, budget: dict[str, object]) -> str:
    preferred = _positive_int(
        budget.get("preferredMaxBytes"), field="browserArtifactBudget.preferredMaxBytes"
    )
    normal = _positive_int(
        budget.get("normalMaxBytes"), field="browserArtifactBudget.normalMaxBytes"
    )
    absolute = _positive_int(
        budget.get("absoluteMaxBytes"), field="browserArtifactBudget.absoluteMaxBytes"
    )
    if not preferred <= normal <= absolute:
        raise ValueError("browser artifact budget limits must be monotonically increasing")
    if byte_size <= preferred:
        return "preferred"
    if byte_size <= normal:
        return "normal"
    if byte_size <= absolute:
        return "degraded"
    return "rejected"


def verify_artifact_integrity(manifest_path: Path) -> dict[str, object]:
    """Return a measured integrity report or fail closed on any mismatch."""

    if not manifest_path.is_file():
        raise FileNotFoundError(f"split manifest not found: {manifest_path}")
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("split manifest must contain a JSON object")
    if manifest.get("kind") != MANIFEST_KIND:
        raise ValueError(f"unexpected split manifest kind: {manifest.get('kind')}")
    if manifest.get("artifactLayout") != ARTIFACT_LAYOUT:
        raise ValueError(
            "artifact integrity verification requires per-segment external data; "
            f"got {manifest.get('artifactLayout')!r}"
        )

    raw_segments = manifest.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        raise ValueError("split manifest must contain at least one segment")

    budget = manifest.get("browserArtifactBudget")
    if not isinstance(budget, dict):
        raise ValueError("split manifest browserArtifactBudget must be an object")
    split_plan = manifest.get("splitPlan")
    if not isinstance(split_plan, dict):
        raise ValueError("split manifest splitPlan must be an object")

    budget_required_max = _positive_int(
        budget.get("requiredMaxBytes"), field="browserArtifactBudget.requiredMaxBytes"
    )
    split_required_max = _positive_int(
        split_plan.get("requiredMaxBytes"), field="splitPlan.requiredMaxBytes"
    )
    effective_required_max = min(budget_required_max, split_required_max)

    raw_budget_segments = budget.get("segments")
    if not isinstance(raw_budget_segments, list) or len(raw_budget_segments) != len(raw_segments):
        raise ValueError("browserArtifactBudget.segments must match manifest segment count")

    root = manifest_path.parent
    reports: list[dict[str, object]] = []
    seen_external_locations: set[tuple[int, str]] = set()

    for expected_index, raw_segment in enumerate(raw_segments):
        if not isinstance(raw_segment, dict):
            raise ValueError(f"segment {expected_index} must be an object")
        index = _non_negative_int(raw_segment.get("index"), field=f"segments[{expected_index}].index")
        if index != expected_index:
            raise ValueError(
                f"segment indices must cover 0..n-1; expected {expected_index}, got {index}"
            )

        graph_path = _safe_relative_path(
            root, raw_segment.get("path"), field=f"segments[{index}].path"
        )
        if not graph_path.is_file():
            raise FileNotFoundError(f"segment graph not found: {graph_path}")
        expected_graph_sha = _canonical_sha256(
            raw_segment.get("sha256"), field=f"segments[{index}].sha256"
        )
        observed_graph_sha = sha256_file(graph_path)
        if observed_graph_sha != expected_graph_sha:
            raise ValueError(
                f"segment {index} graph SHA-256 mismatch: "
                f"expected={expected_graph_sha}, observed={observed_graph_sha}"
            )
        graph_bytes = graph_path.stat().st_size

        raw_external = raw_segment.get("externalData")
        if not isinstance(raw_external, list):
            raise ValueError(f"segments[{index}].externalData must be an array")
        external_reports: list[dict[str, object]] = []
        external_bytes = 0
        for external_index, raw_entry in enumerate(raw_external):
            if not isinstance(raw_entry, dict):
                raise ValueError(
                    f"segments[{index}].externalData[{external_index}] must be an object"
                )
            field_prefix = f"segments[{index}].externalData[{external_index}]"
            location = str(raw_entry.get("location") or "")
            external_path = _safe_relative_path(
                root, location, field=f"{field_prefix}.location"
            )
            identity = (index, location)
            if identity in seen_external_locations:
                raise ValueError(f"segment {index} contains duplicate external data location: {location}")
            seen_external_locations.add(identity)
            if not external_path.is_file():
                raise FileNotFoundError(f"segment external data not found: {external_path}")

            expected_bytes = _non_negative_int(raw_entry.get("bytes"), field=f"{field_prefix}.bytes")
            observed_bytes = external_path.stat().st_size
            if observed_bytes != expected_bytes:
                raise ValueError(
                    f"segment {index} external-data size mismatch for {location}: "
                    f"expected={expected_bytes}, observed={observed_bytes}"
                )
            expected_sha = _canonical_sha256(
                raw_entry.get("sha256"), field=f"{field_prefix}.sha256"
            )
            observed_sha = sha256_file(external_path)
            if observed_sha != expected_sha:
                raise ValueError(
                    f"segment {index} external-data SHA-256 mismatch for {location}: "
                    f"expected={expected_sha}, observed={observed_sha}"
                )
            external_bytes += observed_bytes
            external_reports.append(
                {
                    "location": location,
                    "bytes": observed_bytes,
                    "sha256": observed_sha,
                }
            )

        artifact_bytes = graph_bytes + external_bytes
        declared_artifact_bytes = _non_negative_int(
            raw_segment.get("browserArtifactBytes"),
            field=f"segments[{index}].browserArtifactBytes",
        )
        if artifact_bytes != declared_artifact_bytes:
            raise ValueError(
                f"segment {index} browserArtifactBytes mismatch: "
                f"declared={declared_artifact_bytes}, observed={artifact_bytes}"
            )

        observed_tier = _tier(artifact_bytes, budget)
        declared_tier = str(raw_segment.get("browserArtifactTier") or "")
        if observed_tier != declared_tier:
            raise ValueError(
                f"segment {index} browserArtifactTier mismatch: "
                f"declared={declared_tier!r}, observed={observed_tier!r}"
            )

        raw_budget_entry = raw_budget_segments[index]
        if not isinstance(raw_budget_entry, dict):
            raise ValueError(f"browserArtifactBudget.segments[{index}] must be an object")
        if _non_negative_int(raw_budget_entry.get("index"), field=f"browserArtifactBudget.segments[{index}].index") != index:
            raise ValueError(f"browserArtifactBudget.segments[{index}] index mismatch")
        budget_artifact_bytes = _non_negative_int(
            raw_budget_entry.get("artifactBytes"),
            field=f"browserArtifactBudget.segments[{index}].artifactBytes",
        )
        if budget_artifact_bytes != artifact_bytes:
            raise ValueError(
                f"browserArtifactBudget segment {index} byte count mismatch: "
                f"declared={budget_artifact_bytes}, observed={artifact_bytes}"
            )
        if str(raw_budget_entry.get("tier") or "") != observed_tier:
            raise ValueError(f"browserArtifactBudget segment {index} tier mismatch")
        if artifact_bytes > effective_required_max:
            raise RuntimeError(
                f"segment {index} exceeds effective required browser artifact budget: "
                f"observed={artifact_bytes}, requiredMaxBytes={effective_required_max}"
            )

        reports.append(
            {
                "index": index,
                "path": str(raw_segment["path"]),
                "graphBytes": graph_bytes,
                "graphSha256": observed_graph_sha,
                "externalData": external_reports,
                "externalBytes": external_bytes,
                "artifactBytes": artifact_bytes,
                "tier": observed_tier,
            }
        )

    maximum = max(int(report["artifactBytes"]) for report in reports)
    declared_budget_maximum = _non_negative_int(
        budget.get("maximumSegmentArtifactBytes"),
        field="browserArtifactBudget.maximumSegmentArtifactBytes",
    )
    if declared_budget_maximum != maximum:
        raise ValueError(
            "browserArtifactBudget.maximumSegmentArtifactBytes mismatch: "
            f"declared={declared_budget_maximum}, observed={maximum}"
        )
    declared_plan_maximum = _non_negative_int(
        split_plan.get("maximumGeneratedSegmentBytes"),
        field="splitPlan.maximumGeneratedSegmentBytes",
    )
    if declared_plan_maximum != maximum:
        raise ValueError(
            "splitPlan.maximumGeneratedSegmentBytes mismatch: "
            f"declared={declared_plan_maximum}, observed={maximum}"
        )

    return {
        "schemaVersion": "1.0.0",
        "kind": "unzen-budgeted-multi-segment-artifact-integrity",
        "status": "pass",
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "segmentCount": len(reports),
        "effectiveRequiredMaxBytes": effective_required_max,
        "maximumSegmentArtifactBytes": maximum,
        "segments": reports,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = verify_artifact_integrity(args.manifest)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
