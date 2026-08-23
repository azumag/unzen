#!/usr/bin/env python3
"""Plan and prepare contiguous ONNX layer spans under a byte budget."""

from __future__ import annotations

import argparse
import itertools
import json
from dataclasses import dataclass
from pathlib import Path

import onnx
from onnx import TensorProto

from prepare_browser_p0 import apply_browser_budget
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
    start_layer: int
    end_layer: int
    output_names: tuple[str, ...]
    extra_input_names: tuple[str, ...]


@dataclass(frozen=True)
class PlannedSegment:
    spec: SegmentSpec
    boundary_outputs: tuple[BoundaryTensor, ...]
    estimated_bytes: int


def discover_total_layers(model: onnx.ModelProto) -> int:
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


def build_segment_specs(
    model: onnx.ModelProto,
    cut_layers: tuple[int, ...],
) -> tuple[SegmentSpec, ...]:
    """Build contiguous segment contracts for cuts such as ``(8, 12)``."""

    total_layers = discover_total_layers(model)
    normalized = tuple(sorted(set(cut_layers)))
    if any(layer <= 0 or layer >= total_layers for layer in normalized):
        raise ValueError(
            f"cut layers must be between 1 and {total_layers - 1}: {normalized}"
        )

    present_names = {layer: [] for layer in range(total_layers)}
    for layer, name in _present_outputs(model):
        present_names[layer].append(name)
    logits_names = [
        name
        for name in (output.name for output in model.graph.output)
        if name == "logits" or name.endswith("/logits")
    ]
    if len(logits_names) != 1:
        raise ValueError(f"expected exactly one logits output; found {logits_names}")

    bounds = (0, *normalized, total_layers)
    specs: list[SegmentSpec] = []
    for index, (start, end) in enumerate(zip(bounds, bounds[1:])):
        outputs = [name for layer in range(start, end) for name in present_names[layer]]
        extra_inputs: tuple[str, ...] = ()
        if end < total_layers:
            boundary = _boundary_at(model, end)
            outputs[:0] = [tensor.name for tensor in boundary]
        if index > 0:
            previous_boundary = _boundary_at(model, start)
            extra_inputs = tuple(tensor.name for tensor in previous_boundary)
        if index == len(bounds) - 2:
            outputs.append(logits_names[0])
        specs.append(
            SegmentSpec(
                start_layer=start,
                end_layer=end,
                output_names=tuple(outputs),
                extra_input_names=extra_inputs,
            )
        )
    return tuple(specs)


def _external_initializer_bytes(segment_model: onnx.ModelProto) -> int:
    total = 0
    for initializer in segment_model.graph.initializer:
        if initializer.data_location != TensorProto.EXTERNAL:
            continue
        metadata = {entry.key: entry.value for entry in initializer.external_data}
        location = metadata.get("location")
        if not location:
            raise ValueError(f"external initializer {initializer.name!r} has no location")
        if Path(location).is_absolute() or ".." in Path(location).parts:
            raise ValueError(f"unsafe external-data location: {location}")
        if "length" not in metadata:
            raise ValueError(
                f"external initializer {initializer.name!r} has no explicit length"
            )
        total += int(metadata["length"])
    return total


def estimate_segment_bytes(
    model: onnx.ModelProto,
    spec: SegmentSpec,
    *,
    hidden_size: int,
) -> int:
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


def plan_layer_spans(
    model: onnx.ModelProto,
    *,
    hidden_size: int,
    target_bytes: int,
    required_max_bytes: int,
) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Return cut layers, their costs, and the lowest-count feasible partition."""

    total_layers = discover_total_layers(model)
    cost_cache: dict[tuple[int, int], int] = {}

    def span_cost(start: int, end: int) -> int:
        key = (start, end)
        if key not in cost_cache:
            outputs: list[str] = []
            extra_inputs: tuple[str, ...] = ()
            if end < total_layers:
                outputs.extend(tensor.name for tensor in _boundary_at(model, end))
            else:
                present_by_layer = dict(_present_outputs(model))
                outputs.extend(
                    present_by_layer[layer]
                    for layer in range(start, end)
                    if layer in present_by_layer
                )
                outputs.extend(
                    name
                    for name in (output.name for output in model.graph.output)
                    if name == "logits" or name.endswith("/logits")
                )
            if start > 0:
                extra_inputs = tuple(
                    tensor.name for tensor in _boundary_at(model, start)
                )
            spec = SegmentSpec(start, end, tuple(outputs), extra_inputs)
            cost_cache[key] = estimate_segment_bytes(
                model,
                spec,
                hidden_size=hidden_size,
            )
        return cost_cache[key]

    best: tuple[tuple[int, int, int, tuple[int, ...]], tuple[int, ...]] | None = None
    # All cut-point combinations are bounded by 2^(layers-1). Real decoder
    # models are small enough at this layer count, while keeping the choice
    # exhaustive and deterministic instead of heuristic.
    for count in range(1, total_layers + 1):
        for raw_cuts in itertools.combinations(range(1, total_layers), count - 1):
            cuts = tuple(raw_cuts)
            bounds = (0, *cuts, total_layers)
            costs = tuple(span_cost(start, end) for start, end in zip(bounds, bounds[1:]))
            maximum = max(costs)
            if maximum > required_max_bytes:
                continue
            score = (
                count,
                maximum,
                sum(abs(cost - target_bytes) for cost in costs),
                cuts,
            )
            if best is None or score < best[0]:
                best = (score, costs)
        # The first feasible segment count minimizes checkpoint relays; later
        # counts cannot improve it even if they balance shards better.
        if best is not None:
            break

    if best is None:
        raise RuntimeError(
            f"no contiguous partition keeps every shard <= {required_max_bytes} bytes; "
            "the model violates the configured browser artifact policy"
        )
    return best[0][3], best[1]


def prepare_budgeted_multi_split(
    source_model_path: Path,
    output_dir: Path,
    *,
    hidden_size: int = 2048,
    target_bytes: int,
    preferred_max_bytes: int,
    hash_source_external_data: bool = True,
) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    model = onnx.load_model(str(source_model_path), load_external_data=False)
    cuts, estimated_costs = plan_layer_spans(
        model,
        hidden_size=hidden_size,
        target_bytes=target_bytes,
        required_max_bytes=preferred_max_bytes,
    )
    specs = build_segment_specs(model, cuts)
    if len(specs) != len(estimated_costs):
        raise AssertionError("planner/generator segment count mismatch")

    external_manifest: list[dict[str, object]] = []
    if hash_source_external_data:
        locations: set[str] = set()
        for initializer in model.graph.initializer:
            if initializer.data_location != TensorProto.EXTERNAL:
                continue
            metadata = {entry.key: entry.value for entry in initializer.external_data}
            location = metadata.get("location")
            if not location:
                raise ValueError(f"external initializer {initializer.name!r} has no location")
            locations.add(location)
        for location in sorted(locations):
            source = source_model_path.parent / location
            external_manifest.append({
                "location": location,
                "bytes": source.stat().st_size,
                "sha256": sha256_file(source),
            })

    segments: list[dict[str, object]] = []
    for index, (spec, estimated) in enumerate(zip(specs, estimated_costs)):
        segment = extract_submodel(
            model,
            output_names=spec.output_names,
            extra_input_names=spec.extra_input_names,
            hidden_size=hidden_size,
            graph_name=f"unzen-budgeted-segment-{index}-layers-{spec.start_layer}-{spec.end_layer - 1}",
        )
        segment_path = output_dir / f"segment{index}.onnx"
        onnx.save_model(segment, str(segment_path))
        external = repack_segment_external_data(
            segment_path,
            source_model_path.parent,
            f"segment{index}.onnx_data",
        )
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
        boundaries.append({
            "afterLayer": cut - 1,
            "beforeLayer": cut,
            "tensors": [
                {"name": tensor.name, "producer": tensor.producer_name}
                for tensor in tensors
            ],
        })

    manifest: dict[str, object] = {
        "schemaVersion": "1.0.0",
        "kind": "unzen-budgeted-multi-segment-onnx",
        "sourceModel": {
            "path": str(source_model_path),
            "sha256": sha256_file(source_model_path),
            "externalData": external_manifest,
        },
        "hiddenSize": hidden_size,
        "artifactLayout": "per-segment-external-data",
        "splitPlan": {
            "cutLayers": list(cuts),
            "estimatedSegmentBytes": list(estimated_costs),
        },
        "boundaries": boundaries,
        "segments": segments,
    }

    # Re-run the production gate against real generated bytes, never estimates.
    apply_browser_budget(manifest, output_dir, require_tier="preferred")
    output_manifest = output_dir / "split-manifest.json"
    output_manifest.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    for segment_path in output_dir.glob("segment*.onnx"):
        check_model_for_runtime(segment_path)
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--hidden-size", type=int, default=2048)
    parser.add_argument("--target-bytes", type=int, default=200 * 1024 * 1024)
    parser.add_argument("--preferred-max-bytes", type=int, default=256 * 1024 * 1024)
    parser.add_argument(
        "--skip-source-external-digest",
        action="store_true",
        help="Skip hashing the source full weight blob; generated shard hashes remain mandatory",
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
