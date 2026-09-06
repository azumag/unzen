#!/usr/bin/env python3
"""Explain browser-artifact budget blockers before expensive shard generation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import onnx
from onnx import TensorProto

from multi_segment_onnx import (
    BrowserArtifactBudgetError,
    _external_range,
    _select_partition,
    build_segment_spec,
    discover_total_layers,
    estimate_segment_bytes,
)
from prepare_browser_p0 import (
    ABSOLUTE_MAX_BYTES,
    NORMAL_MAX_BYTES,
    PREFERRED_MAX_BYTES,
    TARGET_BYTES,
)
from split_llama_1b_onnx import extract_submodel, sha256_file

REPORT_KIND = "unzen-multi-segment-browser-budget-diagnostic"
REPORT_SCHEMA_VERSION = "1.0.0"

TIER_LIMITS = (
    ("preferred", PREFERRED_MAX_BYTES),
    ("normal", NORMAL_MAX_BYTES),
    ("absolute", ABSOLUTE_MAX_BYTES),
)


def _span_costs(
    model: onnx.ModelProto,
    *,
    hidden_size: int,
    total_layers: int,
) -> dict[tuple[int, int], int]:
    costs: dict[tuple[int, int], int] = {}
    for start in range(total_layers):
        for end in range(start + 1, total_layers + 1):
            spec = build_segment_spec(
                model,
                start,
                end,
                total_layers=total_layers,
            )
            costs[(start, end)] = estimate_segment_bytes(
                model,
                spec,
                hidden_size=hidden_size,
            )
    return costs


def _partition_report(
    *,
    total_layers: int,
    target_bytes: int,
    tier: str,
    limit_bytes: int,
    costs: dict[tuple[int, int], int],
) -> dict[str, object]:
    try:
        cuts, segment_costs = _select_partition(
            total_layers=total_layers,
            target_bytes=min(target_bytes, limit_bytes),
            required_max_bytes=limit_bytes,
            span_cost=lambda start, end: costs[(start, end)],
        )
    except BrowserArtifactBudgetError as error:
        return {
            "tier": tier,
            "limitBytes": limit_bytes,
            "feasible": False,
            **error.as_dict(),
            "error": str(error),
        }
    return {
        "tier": tier,
        "limitBytes": limit_bytes,
        "feasible": True,
        "cutLayers": list(cuts),
        "estimatedSegmentBytes": list(segment_costs),
        "maximumEstimatedSegmentBytes": max(segment_costs, default=0),
    }


def _initializer_rows(
    model: onnx.ModelProto,
    *,
    start_layer: int,
    end_layer: int,
    total_layers: int,
    hidden_size: int,
    limit: int,
) -> list[dict[str, object]]:
    spec = build_segment_spec(
        model,
        start_layer,
        end_layer,
        total_layers=total_layers,
    )
    segment = extract_submodel(
        model,
        output_names=spec.output_names,
        extra_input_names=spec.extra_input_names,
        hidden_size=hidden_size,
        graph_name=f"unzen-budget-diagnostic-{start_layer}-{end_layer - 1}",
    )
    rows: list[dict[str, object]] = []
    for initializer in segment.graph.initializer:
        if initializer.data_location != TensorProto.EXTERNAL:
            continue
        location, offset, length = _external_range(initializer)
        rows.append(
            {
                "name": initializer.name,
                "location": location,
                "offset": offset,
                "bytes": length,
            }
        )
    rows.sort(key=lambda item: (-int(item["bytes"]), str(item["name"])))
    return rows[:limit]


def diagnose_model(
    source_model_path: Path,
    *,
    hidden_size: int = 2048,
    target_bytes: int = TARGET_BYTES,
    top_initializers: int = 8,
) -> dict[str, object]:
    if hidden_size <= 0 or target_bytes <= 0:
        raise ValueError("hidden_size and target_bytes must be positive")
    if top_initializers < 0:
        raise ValueError("top_initializers must be non-negative")
    source = source_model_path.expanduser().absolute()
    if not source.is_file():
        raise FileNotFoundError(f"source model not found: {source}")

    model = onnx.load_model(str(source), load_external_data=False)
    total_layers = discover_total_layers(model)
    costs = _span_costs(
        model,
        hidden_size=hidden_size,
        total_layers=total_layers,
    )
    partitions = [
        _partition_report(
            total_layers=total_layers,
            target_bytes=target_bytes,
            tier=tier,
            limit_bytes=limit_bytes,
            costs=costs,
        )
        for tier, limit_bytes in TIER_LIMITS
    ]
    single_layers = [
        {
            "layer": layer,
            "estimatedBytes": costs[(layer, layer + 1)],
        }
        for layer in range(total_layers)
    ]
    worst_layers = sorted(
        single_layers,
        key=lambda item: (-int(item["estimatedBytes"]), int(item["layer"])),
    )[: min(4, total_layers)]
    for entry in worst_layers:
        layer = int(entry["layer"])
        entry["topExternalInitializers"] = _initializer_rows(
            model,
            start_layer=layer,
            end_layer=layer + 1,
            total_layers=total_layers,
            hidden_size=hidden_size,
            limit=top_initializers,
        )

    absolute = next(item for item in partitions if item["tier"] == "absolute")
    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "sourceModel": {
            "path": str(source),
            "graphBytes": source.stat().st_size,
            "graphSha256": sha256_file(source),
        },
        "hiddenSize": hidden_size,
        "totalLayers": total_layers,
        "targetBytes": target_bytes,
        "hardPolicyFeasible": bool(absolute["feasible"]),
        "partitions": partitions,
        "singleLayerSpans": single_layers,
        "worstSingleLayerSpans": worst_layers,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path)
    parser.add_argument("--hidden-size", type=int, default=2048)
    parser.add_argument("--target-bytes", type=int, default=TARGET_BYTES)
    parser.add_argument("--top-initializers", type=int, default=8)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = diagnose_model(
        args.source_model,
        hidden_size=args.hidden_size,
        target_bytes=args.target_bytes,
        top_initializers=args.top_initializers,
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
