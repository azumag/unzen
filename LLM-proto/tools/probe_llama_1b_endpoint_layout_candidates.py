#!/usr/bin/env python3
"""Compare pinned Llama 1B endpoint physical-artifact and execution-tile geometries.

This is a diagnostic-only feasibility helper for issue #223. It does not select
an endpoint architecture, define a manifest/cache/runtime contract, or approve a
browser execution profile.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import probe_llama_1b_endpoint_chunk_envelope as envelope_probe


REPORT_KIND = "unzen-pinned-llama-1b-endpoint-layout-candidate-probe"
REPORT_SCHEMA_VERSION = "1.0.0"
PREFERRED_LIMIT_BYTES = 256 * 1024 * 1024
TARGET_BYTES = 200 * 1024 * 1024
PHYSICAL_ARTIFACT_COUNTS = (4, 5, 8)
EXECUTION_TILE_COUNT = 8


def _balanced_ranges(
    *, rows: int, row_bytes: int, count: int, source_offset_bytes: int
) -> list[dict[str, int]]:
    if rows <= 0 or row_bytes <= 0 or count <= 0:
        raise RuntimeError("rows, rowBytes, and count must be positive")
    if count > rows:
        raise RuntimeError("count cannot exceed rows")
    if source_offset_bytes < 0:
        raise RuntimeError("source offset cannot be negative")

    base_rows, larger_count = divmod(rows, count)
    row_cursor = 0
    result: list[dict[str, int]] = []
    for index in range(count):
        row_count = base_rows + (1 if index < larger_count else 0)
        start_row = row_cursor
        end_row = start_row + row_count
        source_start = source_offset_bytes + start_row * row_bytes
        byte_length = row_count * row_bytes
        result.append(
            {
                "index": index,
                "startRow": start_row,
                "endRowExclusive": end_row,
                "rowCount": row_count,
                "sourceOffsetBytes": source_start,
                "sourceEndOffsetBytesExclusive": source_start + byte_length,
                "byteLength": byte_length,
            }
        )
        row_cursor = end_row

    if row_cursor != rows:
        raise RuntimeError("balanced ranges did not cover all rows")
    return result


def _tile_bindings(
    physical: list[dict[str, int]],
    tiles: list[dict[str, int]],
    *,
    row_bytes: int,
) -> list[dict[str, object]]:
    bindings: list[dict[str, object]] = []
    for tile in tiles:
        tile_start = tile["startRow"]
        tile_end = tile["endRowExclusive"]
        slices: list[dict[str, int]] = []
        covered_rows = 0

        for artifact in physical:
            start_row = max(tile_start, artifact["startRow"])
            end_row = min(tile_end, artifact["endRowExclusive"])
            if start_row >= end_row:
                continue
            row_count = end_row - start_row
            byte_length = row_count * row_bytes
            slices.append(
                {
                    "physicalArtifactIndex": artifact["index"],
                    "startRow": start_row,
                    "endRowExclusive": end_row,
                    "rowCount": row_count,
                    "artifactByteOffset": (start_row - artifact["startRow"]) * row_bytes,
                    "byteLength": byte_length,
                }
            )
            covered_rows += row_count

        if covered_rows != tile["rowCount"]:
            raise RuntimeError(
                f"execution tile {tile['index']} is not fully covered by physical artifacts"
            )

        bindings.append(
            {
                "tileIndex": tile["index"],
                "startRow": tile_start,
                "endRowExclusive": tile_end,
                "rowCount": tile["rowCount"],
                "byteLength": tile["byteLength"],
                "physicalSlices": slices,
                "physicalArtifactCount": len(slices),
            }
        )
    return bindings


def _candidate(
    *, rows: int, row_bytes: int, source_offset_bytes: int, physical_count: int
) -> dict[str, object]:
    physical = _balanced_ranges(
        rows=rows,
        row_bytes=row_bytes,
        count=physical_count,
        source_offset_bytes=source_offset_bytes,
    )
    tiles = _balanced_ranges(
        rows=rows,
        row_bytes=row_bytes,
        count=EXECUTION_TILE_COUNT,
        source_offset_bytes=source_offset_bytes,
    )
    bindings = _tile_bindings(physical, tiles, row_bytes=row_bytes)
    maximum_physical_bytes = max(item["byteLength"] for item in physical)
    maximum_tile_bytes = max(item["byteLength"] for item in tiles)
    physical_boundaries = {
        row
        for artifact in physical
        for row in (artifact["startRow"], artifact["endRowExclusive"])
    }

    return {
        "physicalArtifactCount": physical_count,
        "executionTileCount": EXECUTION_TILE_COUNT,
        "physicalArtifacts": physical,
        "executionTiles": bindings,
        "maximumPhysicalArtifactBytes": maximum_physical_bytes,
        "maximumExecutionTileBytes": maximum_tile_bytes,
        "preferredPhysicalArtifactLimitBytes": PREFERRED_LIMIT_BYTES,
        "physicalArtifactsFitPreferredPayloadLimit": (
            maximum_physical_bytes <= PREFERRED_LIMIT_BYTES
        ),
        "targetBytes": TARGET_BYTES,
        "maximumPhysicalArtifactDistanceFromTargetBytes": (
            maximum_physical_bytes - TARGET_BYTES
        ),
        "maximumPhysicalArtifactsPerExecutionTile": max(
            item["physicalArtifactCount"] for item in bindings
        ),
        "executionTilesContainedWithinSinglePhysicalArtifact": all(
            item["physicalArtifactCount"] == 1 for item in bindings
        ),
        "allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries": all(
            tile["startRow"] in physical_boundaries
            and tile["endRowExclusive"] in physical_boundaries
            for tile in tiles
        ),
    }


def build_report(source_model_path: Path) -> dict[str, object]:
    envelope = envelope_probe.probe_graph(source_model_path)
    if envelope.get("decisionStatus") != "diagnostic-only":
        raise RuntimeError("endpoint chunk envelope must remain diagnostic-only")

    endpoint = envelope.get("endpointChunkEnvelope")
    if not isinstance(endpoint, dict):
        raise RuntimeError("endpointChunkEnvelope must be an object")
    embedding = endpoint.get("embedding-prefix")
    logits = endpoint.get("logits-postfix")
    if not isinstance(embedding, dict) or not isinstance(logits, dict):
        raise RuntimeError("both pinned endpoint stages are required")

    rows = embedding.get("rows")
    row_bytes = embedding.get("rowBytes")
    source_offset_bytes = embedding.get("sourceOffsetBytes")
    source_location = embedding.get("sourceLocation")
    if (
        not isinstance(rows, int)
        or isinstance(rows, bool)
        or not isinstance(row_bytes, int)
        or isinstance(row_bytes, bool)
        or not isinstance(source_offset_bytes, int)
        or isinstance(source_offset_bytes, bool)
        or not isinstance(source_location, str)
        or not source_location
    ):
        raise RuntimeError("pinned endpoint geometry is invalid")
    if (
        logits.get("rows") != rows
        or logits.get("rowBytes") != row_bytes
        or logits.get("sourceOffsetBytes") != source_offset_bytes
        or logits.get("sourceLocation") != source_location
    ):
        raise RuntimeError("embedding/logits tied-weight geometry diverged")

    candidates = [
        _candidate(
            rows=rows,
            row_bytes=row_bytes,
            source_offset_bytes=source_offset_bytes,
            physical_count=count,
        )
        for count in PHYSICAL_ARTIFACT_COUNTS
    ]

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "decisionStatus": "diagnostic-only",
        "sourceGraphSha256": envelope.get("sourceGraphSha256"),
        "sourceLocation": source_location,
        "rows": rows,
        "rowBytes": row_bytes,
        "weightBytes": rows * row_bytes,
        "candidatePolicy": {
            "physicalArtifactCounts": list(PHYSICAL_ARTIFACT_COUNTS),
            "executionTileCount": EXECUTION_TILE_COUNT,
            "preferredPhysicalArtifactLimitBytes": PREFERRED_LIMIT_BYTES,
            "targetBytes": TARGET_BYTES,
        },
        "candidates": candidates,
        "conclusion": (
            "4, 5, and 8 balanced physical layouts are byte-feasible under the "
            "preferred payload ceiling; 8 execution tiles are only source-row views. "
            "This report does not establish ORT/WebGPU feasibility, peak memory, "
            "cache behavior, numerical equivalence, or a chosen #223 architecture."
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
