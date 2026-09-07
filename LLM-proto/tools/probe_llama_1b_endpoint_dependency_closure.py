#!/usr/bin/env python3
"""Measure full-physical-artifact dependency closure for pinned endpoint tiles.

This is a diagnostic-only S0 helper for issue #223. It consumes the arithmetic
layout-candidate report and asks a narrower question: if cache/residency is
accounted at whole physical-artifact granularity, how many full artifact bytes
must be available for each execution tile? It does not claim those bytes are
simultaneously resident in host/GPU memory and does not select an architecture.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import probe_llama_1b_endpoint_layout_candidates as layout_probe


REPORT_KIND = "unzen-pinned-llama-1b-endpoint-dependency-closure-probe"
REPORT_SCHEMA_VERSION = "1.0.0"


def _positive_int(value: object, *, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise RuntimeError(f"{field} must be a positive integer")
    return value


def _non_negative_int(value: object, *, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise RuntimeError(f"{field} must be a non-negative integer")
    return value


def _candidate_dependency_closure(candidate: dict[str, object]) -> dict[str, object]:
    physical = candidate.get("physicalArtifacts")
    tiles = candidate.get("executionTiles")
    if not isinstance(physical, list) or not physical:
        raise RuntimeError("candidate physicalArtifacts must be a non-empty array")
    if not isinstance(tiles, list) or not tiles:
        raise RuntimeError("candidate executionTiles must be a non-empty array")

    preferred_reference = _positive_int(
        candidate.get("preferredPhysicalArtifactLimitBytes"),
        field="preferredPhysicalArtifactLimitBytes",
    )
    physical_count = _positive_int(
        candidate.get("physicalArtifactCount"), field="physicalArtifactCount"
    )
    if physical_count != len(physical):
        raise RuntimeError("physicalArtifactCount does not match physicalArtifacts")

    artifact_bytes: dict[int, int] = {}
    for artifact in physical:
        if not isinstance(artifact, dict):
            raise RuntimeError("physical artifact entry must be an object")
        index = _non_negative_int(artifact.get("index"), field="physical artifact index")
        byte_length = _positive_int(
            artifact.get("byteLength"), field=f"physical artifact {index} byteLength"
        )
        if index in artifact_bytes:
            raise RuntimeError(f"duplicate physical artifact index {index}")
        artifact_bytes[index] = byte_length

    tile_closures: list[dict[str, object]] = []
    for tile in tiles:
        if not isinstance(tile, dict):
            raise RuntimeError("execution tile entry must be an object")
        tile_index = _non_negative_int(tile.get("tileIndex"), field="tileIndex")
        tile_bytes = _positive_int(
            tile.get("byteLength"), field=f"execution tile {tile_index} byteLength"
        )
        slices = tile.get("physicalSlices")
        if not isinstance(slices, list) or not slices:
            raise RuntimeError(
                f"execution tile {tile_index} physicalSlices must be a non-empty array"
            )

        required_indices: list[int] = []
        seen_indices: set[int] = set()
        slice_bytes = 0
        for physical_slice in slices:
            if not isinstance(physical_slice, dict):
                raise RuntimeError(
                    f"execution tile {tile_index} physical slice must be an object"
                )
            artifact_index = _non_negative_int(
                physical_slice.get("physicalArtifactIndex"),
                field=f"execution tile {tile_index} physicalArtifactIndex",
            )
            if artifact_index not in artifact_bytes:
                raise RuntimeError(
                    f"execution tile {tile_index} references unknown physical artifact "
                    f"{artifact_index}"
                )
            if artifact_index in seen_indices:
                raise RuntimeError(
                    f"execution tile {tile_index} references physical artifact "
                    f"{artifact_index} more than once"
                )
            seen_indices.add(artifact_index)
            required_indices.append(artifact_index)
            slice_bytes += _positive_int(
                physical_slice.get("byteLength"),
                field=f"execution tile {tile_index} slice byteLength",
            )

        if slice_bytes != tile_bytes:
            raise RuntimeError(
                f"execution tile {tile_index} slice bytes do not match tile byteLength"
            )

        full_dependency_bytes = sum(artifact_bytes[index] for index in required_indices)
        if full_dependency_bytes < tile_bytes:
            raise RuntimeError(
                f"execution tile {tile_index} full-artifact dependency is smaller than tile"
            )
        unused_bytes = full_dependency_bytes - tile_bytes
        distance_from_preferred_reference = full_dependency_bytes - preferred_reference

        tile_closures.append(
            {
                "tileIndex": tile_index,
                "executionTileBytes": tile_bytes,
                "requiredPhysicalArtifactIndices": required_indices,
                "requiredPhysicalArtifactCount": len(required_indices),
                "fullArtifactDependencyBytes": full_dependency_bytes,
                "unusedBytesWithinRequiredFullArtifacts": unused_bytes,
                "distanceFromPreferredPhysicalArtifactReferenceBytes": (
                    distance_from_preferred_reference
                ),
            }
        )

    return {
        "physicalArtifactCount": physical_count,
        "executionTileCount": len(tile_closures),
        "preferredPhysicalArtifactReferenceBytes": preferred_reference,
        "tileClosures": tile_closures,
        "maximumFullArtifactDependencyBytesPerExecutionTile": max(
            item["fullArtifactDependencyBytes"] for item in tile_closures
        ),
        "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile": max(
            item["unusedBytesWithinRequiredFullArtifacts"] for item in tile_closures
        ),
        "maximumDistanceFromPreferredPhysicalArtifactReferenceBytes": max(
            item["distanceFromPreferredPhysicalArtifactReferenceBytes"]
            for item in tile_closures
        ),
    }


def build_report(source_model_path: Path) -> dict[str, object]:
    layout = layout_probe.build_report(source_model_path)
    if layout.get("kind") != layout_probe.REPORT_KIND:
        raise RuntimeError("unexpected upstream endpoint layout report kind")
    if layout.get("decisionStatus") != "diagnostic-only":
        raise RuntimeError("endpoint layout report must remain diagnostic-only")

    candidates = layout.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise RuntimeError("endpoint layout report candidates must be a non-empty array")
    closures = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise RuntimeError("endpoint layout candidate must be an object")
        closures.append(_candidate_dependency_closure(candidate))

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "decisionStatus": "diagnostic-only",
        "upstreamProbe": {
            "kind": layout.get("kind"),
            "schemaVersion": layout.get("schemaVersion"),
        },
        "sourceGraphSha256": layout.get("sourceGraphSha256"),
        "pinnedSourceExternalDataIdentity": layout.get(
            "pinnedSourceExternalDataIdentity"
        ),
        "candidatePolicy": layout.get("candidatePolicy"),
        "candidateDependencyClosures": closures,
        "conclusion": (
            "This report counts whole physical artifacts referenced by each execution tile. "
            "The preferred physical-artifact limit is carried only as a numeric reference, "
            "not applied as a new execution-closure policy. This is a cache/residency "
            "dependency-closure calculation only: it does not prove host or GPU resident "
            "memory, ORT/WebGPU range binding, cache behavior, latency, numerical "
            "equivalence, or a chosen #223 architecture."
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
