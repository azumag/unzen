#!/usr/bin/env python3
"""Plan and prepare contiguous ONNX layer spans under a byte budget."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Callable

import onnx
from onnx import TensorProto

from prepare_browser_p0 import PREFERRED_MAX_BYTES, apply_browser_budget
from prepare_real_split import repack_segment_external_data
from split_llama_1b_onnx import (
    BoundaryTensor,
    _present_outputs,
    check_model_for_runtime,
    discover_boundary,
    extract_submodel,
    sha256_file,
)


@dataclass(frozen=True)
class SegmentSpec:
    """Dependency-closed graph contract for one contiguous decoder-layer span."""

    start_layer: int
    end_layer: int
    output_names: tuple[str, ...]
    extra_input_names: tuple[str, ...]


SpanCost = Callable[[int, int], int]


class BrowserArtifactBudgetError(RuntimeError):
    """Structured fail-close result for an infeasible browser shard budget."""

    def __init__(
        self,
        *,
        required_max_bytes: int,
        minimum_achievable_maximum_bytes: int,
        oversized_single_layer_spans: tuple[tuple[int, int], ...],
    ) -> None:
        self.required_max_bytes = required_max_bytes
        self.minimum_achievable_maximum_bytes = minimum_achievable_maximum_bytes
        self.oversized_single_layer_spans = oversized_single_layer_spans
        singleton_preview = ", ".join(
            f"[{layer},{layer + 1})={cost}"
            for layer, cost in oversized_single_layer_spans[:8]
        )
        if len(oversized_single_layer_spans) > 8:
            singleton_preview += (
                f", ... (+{len(oversized_single_layer_spans) - 8} more)"
            )
        singleton_detail = (
            f"; single-layer spans over budget: {singleton_preview}"
            if singleton_preview
            else ""
        )
        super().__init__(
            f"no contiguous partition keeps every shard <= {required_max_bytes} bytes; "
            f"minimum achievable maximum is {minimum_achievable_maximum_bytes} bytes"
            f"{singleton_detail}; "
            "the model violates the configured browser artifact policy"
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "requiredMaxBytes": self.required_max_bytes,
            "minimumAchievableMaximumBytes": self.minimum_achievable_maximum_bytes,
            "oversizedSingleLayerSpans": [
                {
                    "startLayer": layer,
                    "endLayer": layer + 1,
                    "estimatedBytes": cost,
                }
                for layer, cost in self.oversized_single_layer_spans
            ],
        }


def discover_total_layers(model: onnx.ModelProto) -> int:
    """Infer the contiguous decoder-layer count from present key/value outputs."""

    present_layers = [layer for layer, _ in _present_outputs(model)]
    if not present_layers:
        raise ValueError("model has no present.{layer}.key/value outputs")
    expected = set(range(max(present_layers) + 1))
    missing = sorted(expected - set(present_layers))
    if missing:
        raise ValueError(f"missing present outputs for layers: {missing}")
    return max(present_layers) + 1


def _boundary_at(model: onnx.ModelProto, layer: int) -> tuple[BoundaryTensor, ...]:
    return discover_boundary(model, layer)


def _logits_output_name(model: onnx.ModelProto) -> str:
    logits_names = [
        name
        for name in (output.name for output in model.graph.output)
        if name == "logits" or name.endswith("/logits")
    ]
    if len(logits_names) != 1:
        raise ValueError(f"expected exactly one logits output; found {logits_names}")
    return logits_names[0]


def build_segment_spec(
    model: onnx.ModelProto,
    start_layer: int,
    end_layer: int,
    *,
    total_layers: int | None = None,
) -> SegmentSpec:
    """Build the exact output/input contract used by both planning and generation.

    Using one builder is important: estimating a smaller graph contract than the
    graph later written to disk can undercount shared initializers and choose a
    partition that only fails after expensive artifact generation.
    """

    total = discover_total_layers(model) if total_layers is None else total_layers
    if start_layer < 0 or end_layer > total or start_layer >= end_layer:
        raise ValueError(
            f"invalid layer span [{start_layer}, {end_layer}) for {total} layers"
        )

    # Preserve every present key/value output owned by this span. These outputs
    # are part of the real exported graph contract and may retain dependencies
    # that materially change both the graph and external-weight byte count.
    outputs = [
        name
        for layer, name in _present_outputs(model)
        if start_layer <= layer < end_layer
    ]
    if end_layer < total:
        outputs[:0] = [tensor.name for tensor in _boundary_at(model, end_layer)]
    else:
        outputs.append(_logits_output_name(model))

    extra_inputs: tuple[str, ...] = ()
    if start_layer > 0:
        extra_inputs = tuple(
            tensor.name for tensor in _boundary_at(model, start_layer)
        )

    return SegmentSpec(
        start_layer=start_layer,
        end_layer=end_layer,
        output_names=tuple(outputs),
        extra_input_names=extra_inputs,
    )


def build_segment_specs(
    model: onnx.ModelProto,
    cut_layers: tuple[int, ...],
) -> tuple[SegmentSpec, ...]:
    """Build contiguous segment contracts for cuts such as ``(8, 12)``."""

    total_layers = discover_total_layers(model)
    if (
        tuple(sorted(cut_layers)) != cut_layers
        or len(set(cut_layers)) != len(cut_layers)
    ):
        raise ValueError(f"cut layers must be strictly increasing: {cut_layers}")
    if any(layer <= 0 or layer >= total_layers for layer in cut_layers):
        raise ValueError(
            f"cut layers must be between 1 and {total_layers - 1}: {cut_layers}"
        )

    bounds = (0, *cut_layers, total_layers)
    return tuple(
        build_segment_spec(model, start, end, total_layers=total_layers)
        for start, end in zip(bounds, bounds[1:])
    )


def _external_range(initializer: TensorProto) -> tuple[str, int, int]:
    """Parse and validate one ONNX external-data byte range.

    ONNX external tensors are byte ranges inside a relative external-data file.
    The planner performs the same non-negative range validation as the repacker
    so estimates and generated artifacts cannot disagree on malformed metadata.
    """

    metadata = {entry.key: entry.value for entry in initializer.external_data}
    location = metadata.get("location")
    if not location:
        raise ValueError(f"external initializer {initializer.name!r} has no location")

    posix = PurePosixPath(location)
    windows = PureWindowsPath(location)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or ".." in posix.parts
        or ".." in windows.parts
    ):
        raise ValueError(f"unsafe external-data location: {location}")

    if "length" not in metadata:
        raise ValueError(
            f"external initializer {initializer.name!r} has no explicit length"
        )
    try:
        offset = int(metadata.get("offset", "0"))
        length = int(metadata["length"])
    except ValueError as error:
        raise ValueError(
            f"external initializer {initializer.name!r} has a non-integer range"
        ) from error
    if offset < 0 or length < 0:
        raise ValueError(
            f"external initializer {initializer.name!r} has a negative range"
        )
    return location, offset, length


def _external_initializer_bytes(segment_model: onnx.ModelProto) -> int:
    """Count the bytes the repacker will actually materialize for a segment."""

    # Multiple initializers may intentionally alias the same source byte range.
    # ``repack_segment_external_data`` writes that range once, so the planner
    # must deduplicate by the same (location, offset, length) identity.
    ranges = {
        _external_range(initializer)
        for initializer in segment_model.graph.initializer
        if initializer.data_location == TensorProto.EXTERNAL
    }
    return sum(length for _, _, length in ranges)


def estimate_segment_bytes(
    model: onnx.ModelProto,
    spec: SegmentSpec,
    *,
    hidden_size: int,
) -> int:
    """Estimate the generated graph bytes plus deduplicated external payload."""

    segment = extract_submodel(
        model,
        output_names=spec.output_names,
        extra_input_names=spec.extra_input_names,
        hidden_size=hidden_size,
        graph_name=f"unzen-budget-segment-{spec.start_layer}-{spec.end_layer - 1}",
    )
    # Serialization excludes external payloads and closely tracks the graph
    # component of the saved .onnx artifact.
    return len(segment.SerializeToString()) + _external_initializer_bytes(segment)


def _select_partition(
    *,
    total_layers: int,
    target_bytes: int,
    required_max_bytes: int,
    span_cost: SpanCost,
) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Solve the contiguous linear-partition problem in polynomial time.

    Objectives are lexicographic:
    1. use the fewest segments that satisfy the required maximum;
    2. minimize the largest segment;
    3. minimize total distance from the target size;
    4. choose lexicographically earlier cuts for deterministic output.

    The first dynamic program finds the exact minimax ceiling for each segment
    count. The second reconstructs the minimum-deviation partition under that
    ceiling. This avoids enumerating all 2^(layers-1) cut combinations.
    """

    if total_layers <= 0:
        raise ValueError("total_layers must be positive")
    if target_bytes <= 0 or required_max_bytes <= 0:
        raise ValueError("target_bytes and required_max_bytes must be positive")
    if target_bytes > required_max_bytes:
        raise ValueError("target_bytes cannot exceed required_max_bytes")

    costs: dict[tuple[int, int], int] = {}
    for start in range(total_layers):
        for end in range(start + 1, total_layers + 1):
            cost = int(span_cost(start, end))
            if cost < 0:
                raise ValueError(f"negative span cost for [{start}, {end}): {cost}")
            costs[(start, end)] = cost

    # Exactly zero segments can cover exactly zero layers with a zero maximum.
    previous_minimax: dict[int, int] = {0: 0}
    chosen_count: int | None = None
    chosen_ceiling: int | None = None
    minimum_achievable_ceiling: int | None = None

    for segment_count in range(1, total_layers + 1):
        current_minimax: dict[int, int] = {}
        for end in range(segment_count, total_layers + 1):
            best: int | None = None
            for start in range(segment_count - 1, end):
                prefix = previous_minimax.get(start)
                if prefix is None:
                    continue
                candidate = max(prefix, costs[(start, end)])
                if best is None or candidate < best:
                    best = candidate
            if best is not None:
                current_minimax[end] = best

        final_ceiling = current_minimax.get(total_layers)
        if final_ceiling is not None:
            if (
                minimum_achievable_ceiling is None
                or final_ceiling < minimum_achievable_ceiling
            ):
                minimum_achievable_ceiling = final_ceiling
            if final_ceiling <= required_max_bytes:
                chosen_count = segment_count
                chosen_ceiling = final_ceiling
                break
        previous_minimax = current_minimax

    if chosen_count is None or chosen_ceiling is None:
        if minimum_achievable_ceiling is None:
            raise AssertionError("partitioner produced no complete partition")
        oversized_singletons = tuple(
            (layer, costs[(layer, layer + 1)])
            for layer in range(total_layers)
            if costs[(layer, layer + 1)] > required_max_bytes
        )
        raise BrowserArtifactBudgetError(
            required_max_bytes=required_max_bytes,
            minimum_achievable_maximum_bytes=minimum_achievable_ceiling,
            oversized_single_layer_spans=oversized_singletons,
        )

    # With the minimax ceiling fixed, deviation is additive, so retaining the
    # best (deviation, cuts) prefix for each state is globally optimal.
    previous: dict[int, tuple[int, tuple[int, ...]]] = {0: (0, ())}
    for segment_count in range(1, chosen_count + 1):
        current: dict[int, tuple[int, tuple[int, ...]]] = {}
        for end in range(segment_count, total_layers + 1):
            best: tuple[int, tuple[int, ...]] | None = None
            for start in range(segment_count - 1, end):
                prefix = previous.get(start)
                cost = costs[(start, end)]
                if prefix is None or cost > chosen_ceiling:
                    continue
                cuts = prefix[1] + (() if end == total_layers else (end,))
                candidate = (
                    prefix[0] + abs(cost - target_bytes),
                    cuts,
                )
                if best is None or candidate < best:
                    best = candidate
            if best is not None:
                current[end] = best
        previous = current

    final = previous.get(total_layers)
    if final is None:
        raise AssertionError("minimax partition could not be reconstructed")
    cut_layers = final[1]
    bounds = (0, *cut_layers, total_layers)
    segment_costs = tuple(
        costs[(start, end)] for start, end in zip(bounds, bounds[1:])
    )
    return cut_layers, segment_costs


def plan_layer_spans(
    model: onnx.ModelProto,
    *,
    hidden_size: int,
    target_bytes: int,
    required_max_bytes: int,
) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Return cut layers and estimated costs for the optimal feasible partition."""

    total_layers = discover_total_layers(model)
    cost_cache: dict[tuple[int, int], int] = {}

    def span_cost(start: int, end: int) -> int:
        key = (start, end)
        if key not in cost_cache:
            spec = build_segment_spec(
                model,
                start,
                end,
                total_layers=total_layers,
            )
            cost_cache[key] = estimate_segment_bytes(
                model,
                spec,
                hidden_size=hidden_size,
            )
        return cost_cache[key]

    return _select_partition(
        total_layers=total_layers,
        target_bytes=target_bytes,
        required_max_bytes=required_max_bytes,
        span_cost=span_cost,
    )


def _source_external_manifest(
    model: onnx.ModelProto,
    source_model_path: Path,
    *,
    hash_files: bool,
) -> list[dict[str, object]]:
    """Validate source ranges and describe each referenced external-data file."""

    ranges_by_location: dict[str, set[tuple[int, int]]] = {}
    for initializer in model.graph.initializer:
        if initializer.data_location != TensorProto.EXTERNAL:
            continue
        location, offset, length = _external_range(initializer)
        ranges_by_location.setdefault(location, set()).add((offset, length))

    manifest: list[dict[str, object]] = []
    for location in sorted(ranges_by_location):
        source = source_model_path.parent / Path(location)
        if not source.is_file():
            raise FileNotFoundError(f"external data file not found: {source}")
        file_size = source.stat().st_size
        for offset, length in ranges_by_location[location]:
            if offset + length > file_size:
                raise ValueError(
                    f"external-data range exceeds {location}: "
                    f"offset={offset}, length={length}, fileBytes={file_size}"
                )
        entry: dict[str, object] = {
            "location": location,
            "bytes": file_size,
        }
        if hash_files:
            entry["sha256"] = sha256_file(source)
        manifest.append(entry)
    return manifest


def _validate_budget_options(
    *,
    hidden_size: int,
    target_bytes: int,
    preferred_max_bytes: int,
) -> None:
    if hidden_size <= 0:
        raise ValueError("hidden_size must be positive")
    if target_bytes <= 0 or preferred_max_bytes <= 0:
        raise ValueError("target_bytes and preferred_max_bytes must be positive")
    if target_bytes > preferred_max_bytes:
        raise ValueError("target_bytes cannot exceed preferred_max_bytes")
    if preferred_max_bytes > PREFERRED_MAX_BYTES:
        raise ValueError(
            "preferred_max_bytes cannot relax the product preferred ceiling "
            f"of {PREFERRED_MAX_BYTES} bytes"
        )


def prepare_budgeted_multi_split(
    source_model_path: Path,
    output_dir: Path,
    *,
    hidden_size: int = 2048,
    target_bytes: int,
    preferred_max_bytes: int,
    hash_source_external_data: bool = True,
) -> dict[str, object]:
    """Generate independent browser shards and enforce estimated and real budgets."""

    _validate_budget_options(
        hidden_size=hidden_size,
        target_bytes=target_bytes,
        preferred_max_bytes=preferred_max_bytes,
    )
    if not source_model_path.is_file():
        raise FileNotFoundError(f"source model not found: {source_model_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    model = onnx.load_model(str(source_model_path), load_external_data=False)
    source_external = _source_external_manifest(
        model,
        source_model_path,
        hash_files=hash_source_external_data,
    )

    cuts, estimated_costs = plan_layer_spans(
        model,
        hidden_size=hidden_size,
        target_bytes=target_bytes,
        required_max_bytes=preferred_max_bytes,
    )
    specs = build_segment_specs(model, cuts)
    if len(specs) != len(estimated_costs):
        raise AssertionError("planner/generator segment count mismatch")

    # Fail before opening any output file if a generated name would overwrite
    # the source graph or one of its external-data files. This matters when an
    # operator intentionally reuses the source directory as the output directory.
    source_artifacts = {source_model_path.resolve()}
    source_artifacts.update(
        (source_model_path.parent / str(entry["location"])).resolve()
        for entry in source_external
    )
    generated_artifacts = {
        path.resolve()
        for index in range(len(specs))
        for path in (
            output_dir / f"segment{index}.onnx",
            output_dir / f"segment{index}.onnx_data",
        )
    }
    collisions = sorted(source_artifacts & generated_artifacts, key=str)
    if collisions:
        raise ValueError(
            "generated artifact path would overwrite source data: "
            + ", ".join(str(path) for path in collisions)
        )

    segments: list[dict[str, object]] = []
    for index, (spec, estimated) in enumerate(zip(specs, estimated_costs)):
        segment = extract_submodel(
            model,
            output_names=spec.output_names,
            extra_input_names=spec.extra_input_names,
            hidden_size=hidden_size,
            graph_name=(
                f"unzen-budgeted-segment-{index}-layers-"
                f"{spec.start_layer}-{spec.end_layer - 1}"
            ),
        )
        segment_path = output_dir / f"segment{index}.onnx"
        onnx.save_model(segment, str(segment_path))
        external = repack_segment_external_data(
            segment_path,
            source_model_path.parent,
            f"segment{index}.onnx_data",
        )
        # The repacker validates external-data graphs after rewriting them. A
        # fully embedded graph bypasses the repacker, so validate that path here.
        if external is None:
            check_model_for_runtime(segment_path)
        entry: dict[str, object] = {
            "index": index,
            "path": segment_path.name,
            "sha256": sha256_file(segment_path),
            "startLayer": spec.start_layer,
            "endLayer": spec.end_layer,
            "estimatedBytes": estimated,
            "inputs": [value.name for value in segment.graph.input],
            "outputs": [value.name for value in segment.graph.output],
            "externalData": [] if external is None else [external],
        }
        segments.append(entry)

    boundaries = []
    for cut in cuts:
        tensors = _boundary_at(model, cut)
        boundaries.append(
            {
                "afterLayer": cut - 1,
                "beforeLayer": cut,
                "tensors": [
                    {"name": tensor.name, "producer": tensor.producer_name}
                    for tensor in tensors
                ],
            }
        )

    manifest: dict[str, object] = {
        "schemaVersion": "1.0.0",
        "kind": "unzen-budgeted-multi-segment-onnx",
        "sourceModel": {
            "path": str(source_model_path),
            "sha256": sha256_file(source_model_path),
            "externalData": source_external,
        },
        "hiddenSize": hidden_size,
        "artifactLayout": "per-segment-external-data",
        "splitPlan": {
            "targetBytes": target_bytes,
            "requiredMaxBytes": preferred_max_bytes,
            "cutLayers": list(cuts),
            "estimatedSegmentBytes": list(estimated_costs),
        },
        "boundaries": boundaries,
        "segments": segments,
    }

    # The fixed product policy remains authoritative. The caller-provided
    # ceiling may be stricter (for tests or a smaller deployment profile), so
    # enforce both against real generated graph + external-data byte counts.
    apply_browser_budget(manifest, output_dir, require_tier="preferred")
    oversized = [
        segment
        for segment in segments
        if int(segment["browserArtifactBytes"]) > preferred_max_bytes
    ]
    maximum_generated = max(
        (int(segment["browserArtifactBytes"]) for segment in segments),
        default=0,
    )
    manifest["splitPlan"]["maximumGeneratedSegmentBytes"] = maximum_generated
    if oversized:
        detail = ", ".join(
            f"segment {segment['index']}={segment['browserArtifactBytes']} bytes"
            for segment in oversized
        )
        raise RuntimeError(
            f"generated browser artifact exceeds requested preferred_max_bytes "
            f"({preferred_max_bytes}): {detail}"
        )

    output_manifest = output_dir / "split-manifest.json"
    output_manifest.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--hidden-size", type=int, default=2048)
    parser.add_argument("--target-bytes", type=int, default=200 * 1024 * 1024)
    parser.add_argument(
        "--preferred-max-bytes",
        type=int,
        default=PREFERRED_MAX_BYTES,
        help=(
            "Required generated shard ceiling; may be stricter than, but cannot "
            "exceed, the product preferred ceiling"
        ),
    )
    parser.add_argument(
        "--skip-source-external-digest",
        action="store_true",
        help=(
            "Skip hashing the source full weight blob; generated shard hashes "
            "remain mandatory"
        ),
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    manifest = prepare_budgeted_multi_split(
        args.source_model,
        args.output_dir,
        hidden_size=args.hidden_size,
        target_bytes=args.target_bytes,
        preferred_max_bytes=args.preferred_max_bytes,
        hash_source_external_data=not args.skip_source_external_digest,
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
