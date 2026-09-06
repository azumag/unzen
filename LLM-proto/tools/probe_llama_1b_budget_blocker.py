#!/usr/bin/env python3
"""Pin the real Llama-3.2-1B q4 layer-only budget blocker in CI."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from diagnose_multi_segment_budget import diagnose_model


REPORT_KIND = "unzen-pinned-llama-1b-budget-blocker-probe"
REPORT_SCHEMA_VERSION = "1.0.0"
EXPECTED_GRAPH_SHA256 = (
    "a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46"
)
EXPECTED_TOTAL_LAYERS = 16
EXPECTED_MINIMUM_MAX_BYTES = 1_122_275_890
EXPECTED_OVERSIZED_SINGLETONS = [
    {"startLayer": 0, "endLayer": 1, "estimatedBytes": 1_122_266_530},
    {"startLayer": 15, "endLayer": 16, "estimatedBytes": 1_122_275_890},
]
EXPECTED_ENDPOINT_INITIALIZER = "model.embed_tokens.weight"
EXPECTED_ENDPOINT_INITIALIZER_BYTES = 1_050_673_152
EXPECTED_TIERS = ("preferred", "normal", "absolute")
EXPECTED_ENDPOINT_STAGE_ARTIFACTS = {
    "embedding-prefix": 1_050_673_652,
    "logits-postfix": 1_050_682_706,
}
EXPECTED_ENDPOINT_STAGE_TIERS = {
    "preferred": False,
    "normal": False,
    "absolute": True,
}

EXPECTED_ENDPOINT_STAGE_MARGINS = {
    "embedding-prefix": {
        "preferred": -782_238_196,
        "normal": -513_802_740,
        "absolute": 23_068_172,
    },
    "logits-postfix": {
        "preferred": -782_247_250,
        "normal": -513_811_794,
        "absolute": 23_059_118,
    },
}


def _require_equal(observed: object, expected: object, *, field: str) -> None:
    if observed != expected:
        raise RuntimeError(
            f"pinned 1B budget blocker drift for {field}: "
            f"expected={expected!r}, observed={observed!r}"
        )


def validate_report(report: dict[str, object]) -> dict[str, object]:
    """Reject any drift in the pinned graph identity or measured blocker shape."""

    source = report.get("sourceModel")
    if not isinstance(source, dict):
        raise RuntimeError("diagnostic sourceModel must be an object")
    _require_equal(
        source.get("graphSha256"), EXPECTED_GRAPH_SHA256, field="source graph SHA-256"
    )
    _require_equal(report.get("totalLayers"), EXPECTED_TOTAL_LAYERS, field="layer count")
    _require_equal(report.get("hardPolicyFeasible"), False, field="hard policy feasibility")

    partitions = report.get("partitions")
    if not isinstance(partitions, list):
        raise RuntimeError("diagnostic partitions must be an array")
    _require_equal(
        tuple(item.get("tier") for item in partitions if isinstance(item, dict)),
        EXPECTED_TIERS,
        field="policy tiers",
    )
    for item in partitions:
        if not isinstance(item, dict):
            raise RuntimeError("diagnostic partition entry must be an object")
        tier = item.get("tier")
        _require_equal(item.get("feasible"), False, field=f"{tier} feasibility")
        _require_equal(
            item.get("minimumAchievableMaximumBytes"),
            EXPECTED_MINIMUM_MAX_BYTES,
            field=f"{tier} minimum achievable maximum",
        )
        _require_equal(
            item.get("oversizedSingleLayerSpans"),
            EXPECTED_OVERSIZED_SINGLETONS,
            field=f"{tier} oversized singleton spans",
        )

    worst = report.get("worstSingleLayerSpans")
    if not isinstance(worst, list):
        raise RuntimeError("diagnostic worstSingleLayerSpans must be an array")
    by_layer = {
        item.get("layer"): item
        for item in worst
        if isinstance(item, dict) and item.get("layer") in {0, 15}
    }
    _require_equal(set(by_layer), {0, 15}, field="endpoint singleton coverage")
    for layer in (0, 15):
        rows = by_layer[layer].get("topExternalInitializers")
        if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
            raise RuntimeError(f"layer {layer} must report a top external initializer")
        _require_equal(
            rows[0].get("name"),
            EXPECTED_ENDPOINT_INITIALIZER,
            field=f"layer {layer} top initializer name",
        )
        _require_equal(
            rows[0].get("bytes"),
            EXPECTED_ENDPOINT_INITIALIZER_BYTES,
            field=f"layer {layer} top initializer bytes",
        )

    endpoint = report.get("endpointIsolationCandidates")
    if not isinstance(endpoint, dict):
        raise RuntimeError("diagnostic endpointIsolationCandidates must be an object")
    _require_equal(endpoint.get("available"), True, field="endpoint isolation availability")
    _require_equal(
        endpoint.get("decisionStatus"),
        "diagnostic-only",
        field="endpoint isolation decision status",
    )
    stages = endpoint.get("stages")
    if not isinstance(stages, list):
        raise RuntimeError("endpoint isolation stages must be an array")
    by_kind = {
        item.get("stageKind"): item
        for item in stages
        if isinstance(item, dict) and isinstance(item.get("stageKind"), str)
    }
    _require_equal(
        set(by_kind),
        set(EXPECTED_ENDPOINT_STAGE_ARTIFACTS),
        field="endpoint isolation stage kinds",
    )
    for stage_kind, expected_bytes in EXPECTED_ENDPOINT_STAGE_ARTIFACTS.items():
        stage = by_kind[stage_kind]
        _require_equal(
            stage.get("estimatedArtifactBytes"),
            expected_bytes,
            field=f"{stage_kind} estimated artifact bytes",
        )
        _require_equal(
            stage.get("estimatedTierFeasibility"),
            EXPECTED_ENDPOINT_STAGE_TIERS,
            field=f"{stage_kind} policy tiers",
        )
        _require_equal(
            stage.get("estimatedTierMarginBytes"),
            EXPECTED_ENDPOINT_STAGE_MARGINS[stage_kind],
            field=f"{stage_kind} policy tier margins",
        )
        _require_equal(
            stage.get("smallestPassingTier"),
            "absolute",
            field=f"{stage_kind} smallest passing tier",
        )
        rows = stage.get("topExternalInitializers")
        if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
            raise RuntimeError(f"{stage_kind} must report a top external initializer")
        _require_equal(
            rows[0].get("name"),
            EXPECTED_ENDPOINT_INITIALIZER,
            field=f"{stage_kind} top initializer name",
        )

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "sourceGraphSha256": EXPECTED_GRAPH_SHA256,
        "totalLayers": EXPECTED_TOTAL_LAYERS,
        "minimumAchievableMaximumBytes": EXPECTED_MINIMUM_MAX_BYTES,
        "oversizedSingleLayerSpans": EXPECTED_OVERSIZED_SINGLETONS,
        "endpointInitializer": {
            "name": EXPECTED_ENDPOINT_INITIALIZER,
            "bytes": EXPECTED_ENDPOINT_INITIALIZER_BYTES,
        },
        "endpointIsolationCandidates": {
            "estimatedArtifactBytes": EXPECTED_ENDPOINT_STAGE_ARTIFACTS,
            "estimatedTierFeasibility": EXPECTED_ENDPOINT_STAGE_TIERS,
            "estimatedTierMarginBytes": EXPECTED_ENDPOINT_STAGE_MARGINS,
            "smallestPassingTier": "absolute",
        },
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
