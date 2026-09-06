#!/usr/bin/env python3
"""Pin a conservative graph-only envelope for chunking the 1B endpoint weight."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from diagnose_multi_segment_budget import TIER_LIMITS, diagnose_model


REPORT_KIND = "unzen-pinned-llama-1b-endpoint-chunk-envelope-probe"
REPORT_SCHEMA_VERSION = "1.1.0"
EXPECTED_GRAPH_SHA256 = (
    "a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46"
)
EXPECTED_ROWS = 128_256
EXPECTED_ROW_BYTES = 8_192
EXPECTED_LARGEST_RANGE_BYTES = 1_050_673_152
EXPECTED_SOURCE_LOCATION = "model_q4.onnx_data"
EXPECTED_SOURCE_OFFSET_BYTES = 0
EXPECTED_STAGE_ENVELOPES = {
    "embedding-prefix": {
        "sourceStageResidualBytes": 500,
        "tiers": {
            "preferred": {
                "limitBytes": 268_435_456,
                "maximumWholeRowsPerArtifact": 32_767,
                "minimumPayloadCount": 4,
                "balancedMaximumRows": 32_064,
                "balancedMaximumPayloadBytes": 262_668_288,
                "conservativeMaximumArtifactBytes": 262_668_788,
                "remainingHeadroomBytes": 5_766_668,
            },
            "normal": {
                "limitBytes": 536_870_912,
                "maximumWholeRowsPerArtifact": 65_535,
                "minimumPayloadCount": 2,
                "balancedMaximumRows": 64_128,
                "balancedMaximumPayloadBytes": 525_336_576,
                "conservativeMaximumArtifactBytes": 525_337_076,
                "remainingHeadroomBytes": 11_533_836,
            },
            "absolute": {
                "limitBytes": 1_073_741_824,
                "maximumWholeRowsPerArtifact": 131_071,
                "minimumPayloadCount": 1,
                "balancedMaximumRows": 128_256,
                "balancedMaximumPayloadBytes": 1_050_673_152,
                "conservativeMaximumArtifactBytes": 1_050_673_652,
                "remainingHeadroomBytes": 23_068_172,
            },
        },
    },
    "logits-postfix": {
        "sourceStageResidualBytes": 9_554,
        "tiers": {
            "preferred": {
                "limitBytes": 268_435_456,
                "maximumWholeRowsPerArtifact": 32_766,
                "minimumPayloadCount": 4,
                "balancedMaximumRows": 32_064,
                "balancedMaximumPayloadBytes": 262_668_288,
                "conservativeMaximumArtifactBytes": 262_677_842,
                "remainingHeadroomBytes": 5_757_614,
            },
            "normal": {
                "limitBytes": 536_870_912,
                "maximumWholeRowsPerArtifact": 65_534,
                "minimumPayloadCount": 2,
                "balancedMaximumRows": 64_128,
                "balancedMaximumPayloadBytes": 525_336_576,
                "conservativeMaximumArtifactBytes": 525_346_130,
                "remainingHeadroomBytes": 11_524_782,
            },
            "absolute": {
                "limitBytes": 1_073_741_824,
                "maximumWholeRowsPerArtifact": 131_070,
                "minimumPayloadCount": 1,
                "balancedMaximumRows": 128_256,
                "balancedMaximumPayloadBytes": 1_050_673_152,
                "conservativeMaximumArtifactBytes": 1_050_682_706,
                "remainingHeadroomBytes": 23_059_118,
            },
        },
    },
}


def _required_dict(value: object, *, field: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{field} must be an object")
    return value


def _required_int(value: object, *, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise RuntimeError(f"{field} must be an integer")
    return value


def _required_str(value: object, *, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"{field} must be a non-empty string")
    return value


def _balanced_source_payload_chunks(
    *,
    rows: int,
    row_bytes: int,
    payload_count: int,
    location: str,
    source_offset_bytes: int,
) -> list[dict[str, object]]:
    """Build a deterministic row-balanced source-byte blueprint without materializing it."""

    if rows <= 0 or row_bytes <= 0 or payload_count <= 0:
        raise RuntimeError("rows, rowBytes, and payloadCount must be positive")
    if payload_count > rows:
        raise RuntimeError("payloadCount cannot exceed row count")
    if source_offset_bytes < 0:
        raise RuntimeError("source offset cannot be negative")

    smaller_rows, larger_chunk_count = divmod(rows, payload_count)
    row_cursor = 0
    chunks: list[dict[str, object]] = []
    for chunk_index in range(payload_count):
        row_count = smaller_rows + (1 if chunk_index < larger_chunk_count else 0)
        relative_offset_bytes = row_cursor * row_bytes
        payload_bytes = row_count * row_bytes
        source_start = source_offset_bytes + relative_offset_bytes
        chunks.append(
            {
                "chunkIndex": chunk_index,
                "startRow": row_cursor,
                "endRowExclusive": row_cursor + row_count,
                "rowCount": row_count,
                "sourceLocation": location,
                "sourceOffsetBytes": source_start,
                "sourceEndOffsetBytesExclusive": source_start + payload_bytes,
                "payloadBytes": payload_bytes,
            }
        )
        row_cursor += row_count

    if row_cursor != rows:
        raise RuntimeError("balanced source payload blueprint did not cover all rows")
    return chunks


def _co_located_residual_envelope(stage: dict[str, object]) -> dict[str, object]:
    """Bound artifacts if all existing non-largest bytes live with the largest chunk."""

    graph_bytes = _required_int(stage.get("estimatedGraphBytes"), field="estimatedGraphBytes")
    layout = _required_dict(stage.get("externalDataLayout"), field="externalDataLayout")
    unique_external_bytes = _required_int(
        layout.get("uniqueExternalBytes"), field="uniqueExternalBytes"
    )
    largest_range_bytes = _required_int(
        layout.get("largestRangeBytes"), field="largestRangeBytes"
    )
    largest_range = _required_dict(layout.get("largestRange"), field="largestRange")
    source_location = _required_str(
        largest_range.get("location"), field="largestRange.location"
    )
    source_offset_bytes = _required_int(
        largest_range.get("offset"), field="largestRange.offset"
    )
    source_range_bytes = _required_int(
        largest_range.get("bytes"), field="largestRange.bytes"
    )
    if source_offset_bytes < 0:
        raise RuntimeError("largest external range offset cannot be negative")
    if source_range_bytes != largest_range_bytes:
        raise RuntimeError("largest external range bytes do not match layout summary")
    lower_bound = _required_dict(
        layout.get("firstAxisPayloadChunkLowerBound"),
        field="firstAxisPayloadChunkLowerBound",
    )
    if lower_bound.get("available") is not True:
        raise RuntimeError("first-axis payload chunk lower bound is unavailable")
    rows = _required_int(lower_bound.get("rows"), field="rows")
    row_bytes = _required_int(lower_bound.get("rowBytes"), field="rowBytes")
    range_bytes = _required_int(lower_bound.get("rangeBytes"), field="rangeBytes")
    if rows <= 0 or row_bytes <= 0:
        raise RuntimeError("rows and rowBytes must be positive")
    if range_bytes != largest_range_bytes:
        raise RuntimeError("first-axis range bytes must match largest external range")

    residual_bytes = graph_bytes + unique_external_bytes - largest_range_bytes
    if residual_bytes < 0:
        raise RuntimeError("source-stage residual bytes cannot be negative")

    tiers: dict[str, object] = {}
    for tier, limit_bytes in TIER_LIMITS:
        payload_capacity_bytes = limit_bytes - residual_bytes
        maximum_rows = payload_capacity_bytes // row_bytes
        if maximum_rows <= 0:
            tiers[tier] = {
                "limitBytes": limit_bytes,
                "maximumWholeRowsPerArtifact": 0,
                "minimumPayloadCount": None,
                "feasible": False,
                "reason": "source-stage-residual-leaves-no-room-for-one-row",
            }
            continue
        minimum_count = (rows + maximum_rows - 1) // maximum_rows
        balanced_rows = (rows + minimum_count - 1) // minimum_count
        balanced_payload_bytes = balanced_rows * row_bytes
        maximum_artifact_bytes = balanced_payload_bytes + residual_bytes
        headroom_bytes = limit_bytes - maximum_artifact_bytes
        tiers[tier] = {
            "limitBytes": limit_bytes,
            "maximumWholeRowsPerArtifact": maximum_rows,
            "minimumPayloadCount": minimum_count,
            "balancedMaximumRows": balanced_rows,
            "balancedMaximumPayloadBytes": balanced_payload_bytes,
            "conservativeMaximumArtifactBytes": maximum_artifact_bytes,
            "remainingHeadroomBytes": headroom_bytes,
            "balancedSourcePayloadChunks": _balanced_source_payload_chunks(
                rows=rows,
                row_bytes=row_bytes,
                payload_count=minimum_count,
                location=source_location,
                source_offset_bytes=source_offset_bytes,
            ),
            "feasible": headroom_bytes >= 0,
        }

    return {
        "decisionStatus": "diagnostic-only",
        "assumption": (
            "all current serialized-graph and non-largest external-data bytes are "
            "co-located with the largest balanced payload; new packaging, manifest, "
            "loader, cache, and runtime metadata are excluded"
        ),
        "rows": rows,
        "rowBytes": row_bytes,
        "largestRangeBytes": largest_range_bytes,
        "sourceLocation": source_location,
        "sourceOffsetBytes": source_offset_bytes,
        "sourceStageResidualBytes": residual_bytes,
        "tiers": tiers,
    }


def _require_equal(observed: object, expected: object, *, field: str) -> None:
    if observed != expected:
        raise RuntimeError(
            f"pinned 1B endpoint chunk envelope drift for {field}: "
            f"expected={expected!r}, observed={observed!r}"
        )


def validate_report(report: dict[str, object]) -> dict[str, object]:
    """Validate the pinned graph and return the conservative chunk envelope."""

    source = _required_dict(report.get("sourceModel"), field="sourceModel")
    _require_equal(
        source.get("graphSha256"), EXPECTED_GRAPH_SHA256, field="source graph SHA-256"
    )

    endpoint = _required_dict(
        report.get("endpointIsolationCandidates"), field="endpointIsolationCandidates"
    )
    _require_equal(endpoint.get("available"), True, field="endpoint isolation availability")
    stages = endpoint.get("stages")
    if not isinstance(stages, list):
        raise RuntimeError("endpoint isolation stages must be an array")
    by_kind = {
        stage.get("stageKind"): stage
        for stage in stages
        if isinstance(stage, dict) and isinstance(stage.get("stageKind"), str)
    }
    _require_equal(
        set(by_kind), set(EXPECTED_STAGE_ENVELOPES), field="endpoint stage kinds"
    )

    observed_envelopes: dict[str, object] = {}
    for stage_kind, expected in EXPECTED_STAGE_ENVELOPES.items():
        envelope = _co_located_residual_envelope(by_kind[stage_kind])
        _require_equal(envelope.get("rows"), EXPECTED_ROWS, field=f"{stage_kind} rows")
        _require_equal(
            envelope.get("rowBytes"), EXPECTED_ROW_BYTES, field=f"{stage_kind} row bytes"
        )
        _require_equal(
            envelope.get("largestRangeBytes"),
            EXPECTED_LARGEST_RANGE_BYTES,
            field=f"{stage_kind} largest range bytes",
        )
        _require_equal(
            envelope.get("sourceLocation"),
            EXPECTED_SOURCE_LOCATION,
            field=f"{stage_kind} source location",
        )
        _require_equal(
            envelope.get("sourceOffsetBytes"),
            EXPECTED_SOURCE_OFFSET_BYTES,
            field=f"{stage_kind} source offset",
        )
        _require_equal(
            envelope.get("sourceStageResidualBytes"),
            expected["sourceStageResidualBytes"],
            field=f"{stage_kind} source-stage residual bytes",
        )
        observed_tiers = _required_dict(envelope.get("tiers"), field=f"{stage_kind} tiers")
        for tier, expected_tier in expected["tiers"].items():
            observed_tier = _required_dict(
                observed_tiers.get(tier), field=f"{stage_kind}.{tier}"
            )
            for field, expected_value in expected_tier.items():
                _require_equal(
                    observed_tier.get(field),
                    expected_value,
                    field=f"{stage_kind}.{tier}.{field}",
                )
            expected_chunks = _balanced_source_payload_chunks(
                rows=EXPECTED_ROWS,
                row_bytes=EXPECTED_ROW_BYTES,
                payload_count=int(expected_tier["minimumPayloadCount"]),
                location=EXPECTED_SOURCE_LOCATION,
                source_offset_bytes=EXPECTED_SOURCE_OFFSET_BYTES,
            )
            _require_equal(
                observed_tier.get("balancedSourcePayloadChunks"),
                expected_chunks,
                field=f"{stage_kind}.{tier}.balancedSourcePayloadChunks",
            )
            _require_equal(
                observed_tier.get("feasible"), True, field=f"{stage_kind}.{tier}.feasible"
            )
        observed_envelopes[stage_kind] = envelope

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "sourceGraphSha256": EXPECTED_GRAPH_SHA256,
        "decisionStatus": "diagnostic-only",
        "endpointChunkEnvelope": observed_envelopes,
        "conclusion": (
            "the existing source-stage residual bytes do not increase the pinned raw "
            "minimum chunk counts: preferred remains 4, normal 2, absolute 1; new "
            "packaging/runtime overhead is still unmeasured"
        ),
    }


def probe_graph(source_model_path: Path) -> dict[str, object]:
    return validate_report(diagnose_model(source_model_path))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path)
    args = parser.parse_args()
    print(json.dumps(probe_graph(args.source_model), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
