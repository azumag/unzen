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
    _external_initializer_bytes,
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


def _external_initializer_rows(
    segment: onnx.ModelProto,
    *,
    limit: int,
) -> list[dict[str, object]]:
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


def _external_data_layout(segment: onnx.ModelProto) -> dict[str, object]:
    """Summarize the existing external-data range layout without choosing a split."""

    references: dict[tuple[str, int, int], list[str]] = {}
    for initializer in segment.graph.initializer:
        if initializer.data_location != TensorProto.EXTERNAL:
            continue
        identity = _external_range(initializer)
        references.setdefault(identity, []).append(initializer.name)

    ranges = [
        {
            "location": location,
            "offset": offset,
            "bytes": length,
            "initializerNames": sorted(names),
        }
        for (location, offset, length), names in references.items()
    ]
    ranges.sort(
        key=lambda item: (
            -int(item["bytes"]),
            str(item["location"]),
            int(item["offset"]),
        )
    )
    largest = ranges[0] if ranges else None
    largest_bytes = int(largest["bytes"]) if largest is not None else 0
    return {
        "uniqueRangeCount": len(ranges),
        "uniqueLocationCount": len({str(item["location"]) for item in ranges}),
        "uniqueExternalBytes": sum(int(item["bytes"]) for item in ranges),
        "largestRangeBytes": largest_bytes,
        "largestRange": largest,
        "existingRangeTierFeasibility": {
            tier: largest_bytes <= limit_bytes
            for tier, limit_bytes in TIER_LIMITS
        },
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
    return _external_initializer_rows(segment, limit=limit)


def _producer_map(model: onnx.ModelProto) -> dict[str, onnx.NodeProto]:
    return {
        output: node
        for node in model.graph.node
        for output in node.output
        if output
    }


def _unique_named_node(model: onnx.ModelProto, marker: str) -> onnx.NodeProto:
    matches = [
        node for node in model.graph.node if marker in node.name.lstrip("/")
    ]
    if len(matches) != 1:
        raise ValueError(
            f"expected exactly one node matching {marker!r}; "
            f"found {len(matches)}: {[node.name for node in matches]}"
        )
    return matches[0]


def _stage_budget_report(
    segment: onnx.ModelProto,
    *,
    stage_kind: str,
    output_names: tuple[str, ...],
    extra_input_names: tuple[str, ...],
    top_initializers: int,
) -> dict[str, object]:
    graph_bytes = len(segment.SerializeToString())
    external_bytes = _external_initializer_bytes(segment)
    artifact_bytes = graph_bytes + external_bytes
    tier_feasibility = {
        tier: artifact_bytes <= limit_bytes
        for tier, limit_bytes in TIER_LIMITS
    }
    tier_margins = {
        tier: limit_bytes - artifact_bytes
        for tier, limit_bytes in TIER_LIMITS
    }
    smallest_passing_tier = next(
        (tier for tier, _limit_bytes in TIER_LIMITS if tier_feasibility[tier]),
        None,
    )
    return {
        "stageKind": stage_kind,
        "outputNames": list(output_names),
        "extraInputNames": list(extra_input_names),
        "estimatedGraphBytes": graph_bytes,
        "externalDataBytes": external_bytes,
        "externalDataLayout": _external_data_layout(segment),
        "estimatedArtifactBytes": artifact_bytes,
        "estimatedTierFeasibility": tier_feasibility,
        "estimatedTierMarginBytes": tier_margins,
        "smallestPassingTier": smallest_passing_tier,
        "topExternalInitializers": _external_initializer_rows(
            segment,
            limit=top_initializers,
        ),
    }


def _endpoint_isolation_report(
    model: onnx.ModelProto,
    *,
    total_layers: int,
    hidden_size: int,
    top_initializers: int,
) -> dict[str, object]:
    """Estimate edge-only stages without selecting a runtime decomposition."""

    try:
        producers = _producer_map(model)
        initializer_names = {value.name for value in model.graph.initializer}

        first_norm = _unique_named_node(
            model,
            "model/layers.0/input_layernorm",
        )
        prefix_outputs = tuple(
            input_name
            for input_name in first_norm.input
            if input_name not in initializer_names
            and input_name in producers
            and "model/layers." not in producers[input_name].name.lstrip("/")
        )
        if len(prefix_outputs) != 1:
            raise ValueError(
                "expected one pre-decoder activation feeding layer 0; "
                f"found {list(prefix_outputs)}"
            )

        final_norm = _unique_named_node(
            model,
            f"model/layers.{total_layers}/final_norm_layernorm",
        )
        last_layer_marker = f"model/layers.{total_layers - 1}/"
        postfix_inputs = tuple(
            input_name
            for input_name in final_norm.input
            if input_name in producers
            and last_layer_marker in producers[input_name].name.lstrip("/")
        )
        if not postfix_inputs:
            raise ValueError("final norm has no decoder-owned boundary inputs")

        logits_names = tuple(
            output.name
            for output in model.graph.output
            if output.name == "logits" or output.name.endswith("/logits")
        )
        if len(logits_names) != 1:
            raise ValueError(
                f"expected exactly one logits output; found {list(logits_names)}"
            )

        prefix = extract_submodel(
            model,
            output_names=prefix_outputs,
            hidden_size=hidden_size,
            graph_name="unzen-budget-diagnostic-embedding-prefix",
        )
        postfix = extract_submodel(
            model,
            output_names=logits_names,
            extra_input_names=postfix_inputs,
            hidden_size=hidden_size,
            graph_name="unzen-budget-diagnostic-logits-postfix",
        )
    except ValueError as error:
        return {
            "available": False,
            "decisionStatus": "diagnostic-only",
            "error": str(error),
        }

    return {
        "available": True,
        "decisionStatus": "diagnostic-only",
        "stages": [
            _stage_budget_report(
                prefix,
                stage_kind="embedding-prefix",
                output_names=prefix_outputs,
                extra_input_names=(),
                top_initializers=top_initializers,
            ),
            _stage_budget_report(
                postfix,
                stage_kind="logits-postfix",
                output_names=logits_names,
                extra_input_names=postfix_inputs,
                top_initializers=top_initializers,
            ),
        ],
    }


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
        "endpointIsolationCandidates": _endpoint_isolation_report(
            model,
            total_layers=total_layers,
            hidden_size=hidden_size,
            top_initializers=top_initializers,
        ),
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
