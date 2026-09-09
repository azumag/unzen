#!/usr/bin/env python3
"""Pin the pre-decision 4/8 vs 8/8 Llama 1B endpoint comparison.

This is a diagnostic-only S0/P0 helper for issue #223 / #318. It combines the
existing pinned layout and whole-physical-artifact dependency probes so the two
explicitly requested candidates can be compared without selecting an endpoint
architecture or promoting arithmetic evidence into browser-runtime evidence.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import probe_llama_1b_endpoint_dependency_closure as closure_probe
import probe_llama_1b_endpoint_layout_candidates as layout_probe


REPORT_KIND = "unzen-pinned-llama-1b-endpoint-p0-layout-comparison"
REPORT_SCHEMA_VERSION = "1.0.0"
CANDIDATE_COUNTS = (4, 8)
EXPECTED_EXECUTION_TILE_COUNT = 8
EXPECTED_EXECUTION_TILE_BYTES = 131_334_144
EXPECTED_FOUR_PHYSICAL_BYTES = 262_668_288
EXPECTED_EIGHT_PHYSICAL_BYTES = 131_334_144

REMAINING_EVIDENCE = (
    "generated-8-physical-payload-identity",
    "ort-webgpu-range-supply",
    "captured-adapter-and-device-limits-for-both-layouts",
    "host-peak-working-set",
    "gpu-peak-working-set",
    "download-cache-read-hash-upload-session-and-first-useful-work-timing",
    "session-release-and-cancel-lag",
    "pinned-reference-numerical-equivalence-for-8-physical",
)


def _positive_int(value: object, *, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise RuntimeError(f"{field} must be a positive integer")
    return value


def _non_negative_int(value: object, *, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise RuntimeError(f"{field} must be a non-negative integer")
    return value


def _bool(value: object, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise RuntimeError(f"{field} must be boolean")
    return value


def _sha256(value: object, *, field: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise RuntimeError(f"{field} must be a lowercase SHA-256 hex digest")
    return value


def _external_identity(value: object, *, field: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{field} must be an object")
    location = value.get("location")
    if not isinstance(location, str) or not location:
        raise RuntimeError(f"{field}.location must be a non-empty string")
    byte_length = _positive_int(value.get("bytes"), field=f"{field}.bytes")
    sha256 = _sha256(value.get("sha256"), field=f"{field}.sha256")
    return {"location": location, "bytes": byte_length, "sha256": sha256}


def _candidate_policy(value: object, *, field: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{field} must be an object")
    counts = value.get("physicalArtifactCounts")
    if not isinstance(counts, list) or not counts:
        raise RuntimeError(f"{field}.physicalArtifactCounts must be a non-empty array")
    parsed_counts = [
        _positive_int(count, field=f"{field}.physicalArtifactCounts") for count in counts
    ]
    if len(set(parsed_counts)) != len(parsed_counts):
        raise RuntimeError(f"{field}.physicalArtifactCounts must be unique")
    if any(count not in parsed_counts for count in CANDIDATE_COUNTS):
        raise RuntimeError(f"{field} must include the 4 and 8 physical candidates")

    execution_tile_count = _positive_int(
        value.get("executionTileCount"), field=f"{field}.executionTileCount"
    )
    if execution_tile_count != EXPECTED_EXECUTION_TILE_COUNT:
        raise RuntimeError(f"{field}.executionTileCount drifted")

    preferred_limit = _positive_int(
        value.get("preferredPhysicalArtifactLimitBytes"),
        field=f"{field}.preferredPhysicalArtifactLimitBytes",
    )
    target_bytes = _positive_int(value.get("targetBytes"), field=f"{field}.targetBytes")
    return {
        "physicalArtifactCounts": parsed_counts,
        "executionTileCount": execution_tile_count,
        "preferredPhysicalArtifactLimitBytes": preferred_limit,
        "targetBytes": target_bytes,
    }


def _candidate_map(items: object, *, field: str) -> dict[int, dict[str, object]]:
    if not isinstance(items, list) or not items:
        raise RuntimeError(f"{field} must be a non-empty array")

    mapped: dict[int, dict[str, object]] = {}
    for item in items:
        if not isinstance(item, dict):
            raise RuntimeError(f"{field} entry must be an object")
        count = _positive_int(
            item.get("physicalArtifactCount"),
            field=f"{field}.physicalArtifactCount",
        )
        if count in mapped:
            raise RuntimeError(f"duplicate {field} physicalArtifactCount {count}")
        mapped[count] = item
    return mapped


def _summary(
    candidate: dict[str, object], closure: dict[str, object]
) -> dict[str, object]:
    physical_count = _positive_int(
        candidate.get("physicalArtifactCount"), field="candidate.physicalArtifactCount"
    )
    closure_count = _positive_int(
        closure.get("physicalArtifactCount"), field="closure.physicalArtifactCount"
    )
    if closure_count != physical_count:
        raise RuntimeError("layout/dependency physicalArtifactCount mismatch")

    execution_tile_count = _positive_int(
        candidate.get("executionTileCount"), field="candidate.executionTileCount"
    )
    closure_tile_count = _positive_int(
        closure.get("executionTileCount"), field="closure.executionTileCount"
    )
    if closure_tile_count != execution_tile_count:
        raise RuntimeError("layout/dependency executionTileCount mismatch")

    return {
        "physicalArtifactCount": physical_count,
        "executionTileCount": execution_tile_count,
        "maximumPhysicalArtifactBytes": _positive_int(
            candidate.get("maximumPhysicalArtifactBytes"),
            field="candidate.maximumPhysicalArtifactBytes",
        ),
        "maximumExecutionTileBytes": _positive_int(
            candidate.get("maximumExecutionTileBytes"),
            field="candidate.maximumExecutionTileBytes",
        ),
        "maximumFullArtifactDependencyBytesPerExecutionTile": _positive_int(
            closure.get("maximumFullArtifactDependencyBytesPerExecutionTile"),
            field="closure.maximumFullArtifactDependencyBytesPerExecutionTile",
        ),
        "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile": _non_negative_int(
            closure.get(
                "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"
            ),
            field=(
                "closure."
                "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"
            ),
        ),
        "maximumPhysicalArtifactsPerExecutionTile": _positive_int(
            candidate.get("maximumPhysicalArtifactsPerExecutionTile"),
            field="candidate.maximumPhysicalArtifactsPerExecutionTile",
        ),
        "totalPhysicalSlicesAcrossExecutionTiles": _positive_int(
            candidate.get("totalPhysicalSlicesAcrossExecutionTiles"),
            field="candidate.totalPhysicalSlicesAcrossExecutionTiles",
        ),
        "physicalArtifactsFitPreferredPayloadLimit": _bool(
            candidate.get("physicalArtifactsFitPreferredPayloadLimit"),
            field="candidate.physicalArtifactsFitPreferredPayloadLimit",
        ),
        "executionTileSourceRangesCoverWeightExactly": _bool(
            candidate.get("executionTileSourceRangesCoverWeightExactly"),
            field="candidate.executionTileSourceRangesCoverWeightExactly",
        ),
        "executionTilesContainedWithinSinglePhysicalArtifact": _bool(
            candidate.get("executionTilesContainedWithinSinglePhysicalArtifact"),
            field="candidate.executionTilesContainedWithinSinglePhysicalArtifact",
        ),
        "allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries": _bool(
            candidate.get("allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries"),
            field=(
                "candidate."
                "allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries"
            ),
        ),
    }


def _validate_pinned_geometry(
    four: dict[str, object], eight: dict[str, object]
) -> None:
    if four["executionTileCount"] != EXPECTED_EXECUTION_TILE_COUNT:
        raise RuntimeError("4/8 execution tile count drifted")
    if eight["executionTileCount"] != EXPECTED_EXECUTION_TILE_COUNT:
        raise RuntimeError("8/8 execution tile count drifted")
    if four["maximumExecutionTileBytes"] != EXPECTED_EXECUTION_TILE_BYTES:
        raise RuntimeError("4/8 maximum execution tile bytes drifted")
    if eight["maximumExecutionTileBytes"] != EXPECTED_EXECUTION_TILE_BYTES:
        raise RuntimeError("8/8 maximum execution tile bytes drifted")
    if four["maximumPhysicalArtifactBytes"] != EXPECTED_FOUR_PHYSICAL_BYTES:
        raise RuntimeError("4/8 maximum physical artifact bytes drifted")
    if eight["maximumPhysicalArtifactBytes"] != EXPECTED_EIGHT_PHYSICAL_BYTES:
        raise RuntimeError("8/8 maximum physical artifact bytes drifted")

    for label, summary in (("4/8", four), ("8/8", eight)):
        if not summary["physicalArtifactsFitPreferredPayloadLimit"]:
            raise RuntimeError(f"{label} physical artifact no longer fits preferred limit")
        if not summary["executionTileSourceRangesCoverWeightExactly"]:
            raise RuntimeError(f"{label} execution source coverage drifted")
        if not summary["executionTilesContainedWithinSinglePhysicalArtifact"]:
            raise RuntimeError(f"{label} execution tile now crosses a physical artifact")
        if summary["maximumPhysicalArtifactsPerExecutionTile"] != 1:
            raise RuntimeError(f"{label} physical dependency fanout drifted")
        if summary["totalPhysicalSlicesAcrossExecutionTiles"] != EXPECTED_EXECUTION_TILE_COUNT:
            raise RuntimeError(f"{label} physical slice count drifted")

    if four["allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries"]:
        raise RuntimeError("4/8 unexpectedly aligns every execution boundary")
    if not eight["allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries"]:
        raise RuntimeError("8/8 no longer has 1:1 physical/execution boundaries")

    if (
        four["maximumFullArtifactDependencyBytesPerExecutionTile"]
        != EXPECTED_FOUR_PHYSICAL_BYTES
    ):
        raise RuntimeError("4/8 whole-artifact dependency closure drifted")
    if (
        four["maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"]
        != EXPECTED_EXECUTION_TILE_BYTES
    ):
        raise RuntimeError("4/8 unused whole-artifact bytes drifted")
    if (
        eight["maximumFullArtifactDependencyBytesPerExecutionTile"]
        != EXPECTED_EXECUTION_TILE_BYTES
    ):
        raise RuntimeError("8/8 whole-artifact dependency closure drifted")
    if eight["maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"] != 0:
        raise RuntimeError("8/8 whole-artifact dependency must remain 1:1 with the tile")


def build_report(source_model_path: Path) -> dict[str, object]:
    layout = layout_probe.build_report(source_model_path)
    closure = closure_probe.build_report(source_model_path)

    if layout.get("kind") != layout_probe.REPORT_KIND:
        raise RuntimeError("unexpected endpoint layout report kind")
    if layout.get("schemaVersion") != layout_probe.REPORT_SCHEMA_VERSION:
        raise RuntimeError("unexpected endpoint layout report schema version")
    if closure.get("kind") != closure_probe.REPORT_KIND:
        raise RuntimeError("unexpected endpoint dependency report kind")
    if closure.get("schemaVersion") != closure_probe.REPORT_SCHEMA_VERSION:
        raise RuntimeError("unexpected endpoint dependency report schema version")
    if layout.get("status") != "pass":
        raise RuntimeError("endpoint layout report must have status=pass")
    if closure.get("status") != "pass":
        raise RuntimeError("endpoint dependency report must have status=pass")
    if layout.get("decisionStatus") != "diagnostic-only":
        raise RuntimeError("endpoint layout report must remain diagnostic-only")
    if closure.get("decisionStatus") != "diagnostic-only":
        raise RuntimeError("endpoint dependency report must remain diagnostic-only")

    layout_source_sha = _sha256(
        layout.get("sourceGraphSha256"), field="layout.sourceGraphSha256"
    )
    closure_source_sha = _sha256(
        closure.get("sourceGraphSha256"), field="dependency.sourceGraphSha256"
    )
    if layout_source_sha != closure_source_sha:
        raise RuntimeError("layout/dependency source graph identity mismatch")

    layout_external_identity = _external_identity(
        layout.get("pinnedSourceExternalDataIdentity"),
        field="layout.pinnedSourceExternalDataIdentity",
    )
    closure_external_identity = _external_identity(
        closure.get("pinnedSourceExternalDataIdentity"),
        field="dependency.pinnedSourceExternalDataIdentity",
    )
    if layout_external_identity != closure_external_identity:
        raise RuntimeError("layout/dependency external-data identity mismatch")

    layout_policy = _candidate_policy(
        layout.get("candidatePolicy"), field="layout.candidatePolicy"
    )
    closure_policy = _candidate_policy(
        closure.get("candidatePolicy"), field="dependency.candidatePolicy"
    )
    if layout_policy != closure_policy:
        raise RuntimeError("layout/dependency candidate policy mismatch")

    layout_candidates = _candidate_map(layout.get("candidates"), field="layout.candidates")
    closure_candidates = _candidate_map(
        closure.get("candidateDependencyClosures"),
        field="dependency.candidateDependencyClosures",
    )

    missing = [
        count
        for count in CANDIDATE_COUNTS
        if count not in layout_candidates or count not in closure_candidates
    ]
    if missing:
        raise RuntimeError(f"required P0 comparison candidates missing: {missing}")

    four = _summary(layout_candidates[4], closure_candidates[4])
    eight = _summary(layout_candidates[8], closure_candidates[8])
    _validate_pinned_geometry(four, eight)

    deltas = {
        "physicalArtifactCount": 8 - 4,
        "maximumPhysicalArtifactBytes": (
            eight["maximumPhysicalArtifactBytes"] - four["maximumPhysicalArtifactBytes"]
        ),
        "maximumExecutionTileBytes": (
            eight["maximumExecutionTileBytes"] - four["maximumExecutionTileBytes"]
        ),
        "maximumFullArtifactDependencyBytesPerExecutionTile": (
            eight["maximumFullArtifactDependencyBytesPerExecutionTile"]
            - four["maximumFullArtifactDependencyBytesPerExecutionTile"]
        ),
        "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile": (
            eight["maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"]
            - four["maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"]
        ),
        "totalPhysicalSlicesAcrossExecutionTiles": (
            eight["totalPhysicalSlicesAcrossExecutionTiles"]
            - four["totalPhysicalSlicesAcrossExecutionTiles"]
        ),
    }

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "decisionStatus": "diagnostic-only",
        "selectedPhysicalArtifactCount": None,
        "sourceGraphSha256": layout_source_sha,
        "pinnedSourceExternalDataIdentity": layout_external_identity,
        "upstream": {
            "layout": {
                "kind": layout.get("kind"),
                "schemaVersion": layout.get("schemaVersion"),
            },
            "dependencyClosure": {
                "kind": closure.get("kind"),
                "schemaVersion": closure.get("schemaVersion"),
            },
        },
        "comparisonScope": {
            "physicalArtifactCounts": list(CANDIDATE_COUNTS),
            "executionTileCount": EXPECTED_EXECUTION_TILE_COUNT,
        },
        "candidates": {
            "4-physical-8-tile": four,
            "8-physical-8-tile": eight,
        },
        "deltasEightMinusFour": deltas,
        "remainingEvidence": [
            {
                "id": evidence,
                "status": "not-measured-by-this-probe",
                "requiredBeforeArchitectureSelection": True,
            }
            for evidence in REMAINING_EVIDENCE
        ],
        "conclusion": (
            "The pinned arithmetic keeps the execution tile at 131,334,144 bytes in "
            "both candidates. Moving from 4 physical artifacts to 8 reduces the maximum "
            "whole-artifact dependency closure by 131,334,144 bytes and removes the same "
            "amount of unused bytes from that closure, while increasing physical object "
            "count by four. This is not a layout selection: browser ORT Web/WebGPU range "
            "supply, total host/GPU working set, latency, release/cancel behavior, and "
            "8-physical numerical equivalence remain unmeasured by this report."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path)
    args = parser.parse_args()
    print(json.dumps(build_report(args.source_model), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
