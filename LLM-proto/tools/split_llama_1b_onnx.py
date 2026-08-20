#!/usr/bin/env python3
"""Deterministically split the Llama-3.2-1B q4 ONNX graph at layer 7/8.

The splitter intentionally loads the ModelProto with ``load_external_data=False``.
That keeps large q4 tensor payloads outside Python memory and preserves each
initializer's external-data location/offset/length in both extracted graphs.

It is specialized enough to fail closed on the measured Llama boundary while
keeping the graph extraction algorithm generic and testable with a tiny ONNX
fixture in CI.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import onnx
from onnx import TensorProto, helper


PRESENT_OUTPUT_RE = re.compile(r"(?:^|/)present\.(\d+)\.(key|value)$")


@dataclass(frozen=True)
class BoundaryTensor:
    name: str
    producer_name: str


@dataclass(frozen=True)
class SplitPlan:
    split_layer: int
    boundary_tensors: tuple[BoundaryTensor, ...]
    segment0_outputs: tuple[str, ...]
    segment1_outputs: tuple[str, ...]
    logits_output: str


def sha256_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _all_value_infos(graph: onnx.GraphProto) -> dict[str, onnx.ValueInfoProto]:
    result: dict[str, onnx.ValueInfoProto] = {}
    for value in list(graph.input) + list(graph.output) + list(graph.value_info):
        result[value.name] = value
    return result


def _producer_map(graph: onnx.GraphProto) -> dict[str, onnx.NodeProto]:
    producers: dict[str, onnx.NodeProto] = {}
    for node in graph.node:
        for output in node.output:
            if output:
                producers[output] = node
    return producers


def _layer_marker(layer: int) -> str:
    return f"model/layers.{layer}/"


def discover_boundary(model: onnx.ModelProto, split_layer: int = 8) -> tuple[BoundaryTensor, ...]:
    """Find tensors produced by layer N-1 and consumed by layer N input norm."""

    graph = model.graph
    marker = f"model/layers.{split_layer}/input_layernorm"
    candidates = [
        node
        for node in graph.node
        if marker in node.name.lstrip("/")
    ]
    if len(candidates) != 1:
        names = [node.name for node in candidates]
        raise ValueError(
            f"expected exactly one layer-{split_layer} input_layernorm node; found {len(candidates)}: {names}"
        )

    layer_input = candidates[0]
    producers = _producer_map(graph)
    previous_marker = _layer_marker(split_layer - 1)
    boundary: list[BoundaryTensor] = []
    for tensor_name in layer_input.input:
        producer = producers.get(tensor_name)
        if producer and previous_marker in producer.name.lstrip("/"):
            boundary.append(BoundaryTensor(tensor_name, producer.name))

    if len(boundary) != 2:
        details = [
            {
                "input": tensor_name,
                "producer": producers[tensor_name].name if tensor_name in producers else None,
            }
            for tensor_name in layer_input.input
        ]
        raise ValueError(
            "expected exactly two layer-boundary tensors feeding layer "
            f"{split_layer} input norm; found {len(boundary)}; inputs={details}"
        )
    return tuple(boundary)


def _present_outputs(model: onnx.ModelProto) -> list[tuple[int, str]]:
    present: list[tuple[int, str]] = []
    for output in model.graph.output:
        match = PRESENT_OUTPUT_RE.search(output.name)
        if match:
            present.append((int(match.group(1)), output.name))
    return present


def discover_split_plan(model: onnx.ModelProto, split_layer: int = 8) -> SplitPlan:
    boundary = discover_boundary(model, split_layer)
    graph_outputs = [output.name for output in model.graph.output]
    logits_candidates = [name for name in graph_outputs if name == "logits" or name.endswith("/logits")]
    if len(logits_candidates) != 1:
        raise ValueError(f"expected exactly one logits output; found {logits_candidates}")
    logits_output = logits_candidates[0]

    present = _present_outputs(model)
    lower = [name for layer, name in present if layer < split_layer]
    upper = [name for layer, name in present if layer >= split_layer]

    segment0_outputs = tuple([tensor.name for tensor in boundary] + lower)
    segment1_outputs = tuple([logits_output] + upper)
    return SplitPlan(
        split_layer=split_layer,
        boundary_tensors=boundary,
        segment0_outputs=segment0_outputs,
        segment1_outputs=segment1_outputs,
        logits_output=logits_output,
    )


def _fallback_boundary_value_info(name: str, hidden_size: int) -> onnx.ValueInfoProto:
    return helper.make_tensor_value_info(
        name,
        TensorProto.FLOAT,
        ["batch_size", "sequence_length", hidden_size],
    )


def _copy_value_info(
    name: str,
    value_infos: dict[str, onnx.ValueInfoProto],
    hidden_size: int,
) -> onnx.ValueInfoProto:
    value = value_infos.get(name)
    if value is not None:
        copied = onnx.ValueInfoProto()
        copied.CopyFrom(value)
        return copied
    return _fallback_boundary_value_info(name, hidden_size)


def extract_submodel(
    model: onnx.ModelProto,
    *,
    output_names: Sequence[str],
    extra_input_names: Iterable[str] = (),
    hidden_size: int = 2048,
    graph_name: str,
) -> onnx.ModelProto:
    """Extract the dependency closure while preserving external initializers."""

    graph = model.graph
    producer_by_output: dict[str, int] = {}
    for index, node in enumerate(graph.node):
        for output in node.output:
            if output:
                producer_by_output[output] = index

    graph_input_names = {value.name for value in graph.input}
    initializer_names = {value.name for value in graph.initializer}
    stop_names = graph_input_names | initializer_names | set(extra_input_names)

    needed_nodes: set[int] = set()
    stack = list(output_names)
    while stack:
        tensor_name = stack.pop()
        if not tensor_name or tensor_name in stop_names:
            continue
        producer_index = producer_by_output.get(tensor_name)
        if producer_index is None:
            raise ValueError(f"cannot resolve producer for required tensor: {tensor_name}")
        if producer_index in needed_nodes:
            continue
        needed_nodes.add(producer_index)
        stack.extend(name for name in graph.node[producer_index].input if name)

    selected_nodes = [node for index, node in enumerate(graph.node) if index in needed_nodes]
    referenced_inputs = {name for node in selected_nodes for name in node.input if name}
    selected_initializer_names = referenced_inputs & initializer_names

    value_infos = _all_value_infos(graph)
    segment_input_names = [
        value.name for value in graph.input if value.name in referenced_inputs
    ]
    segment_input_names.extend(
        name for name in extra_input_names if name in referenced_inputs and name not in segment_input_names
    )

    segment_inputs = [
        _copy_value_info(name, value_infos, hidden_size) for name in segment_input_names
    ]
    segment_outputs = [
        _copy_value_info(name, value_infos, hidden_size) for name in output_names
    ]

    selected_initializers: list[onnx.TensorProto] = []
    for initializer in graph.initializer:
        if initializer.name in selected_initializer_names:
            copied = onnx.TensorProto()
            copied.CopyFrom(initializer)
            selected_initializers.append(copied)

    internal_tensor_names = {
        name
        for node in selected_nodes
        for name in list(node.input) + list(node.output)
        if name
    }
    selected_value_info: list[onnx.ValueInfoProto] = []
    output_name_set = set(output_names)
    input_name_set = set(segment_input_names)
    for value in graph.value_info:
        if (
            value.name in internal_tensor_names
            and value.name not in output_name_set
            and value.name not in input_name_set
        ):
            copied = onnx.ValueInfoProto()
            copied.CopyFrom(value)
            selected_value_info.append(copied)

    new_graph = helper.make_graph(
        list(selected_nodes),
        graph_name,
        segment_inputs,
        segment_outputs,
        initializer=selected_initializers,
        value_info=selected_value_info,
    )
    new_model = helper.make_model(
        new_graph,
        producer_name=model.producer_name or "unzen-llm-proto-splitter",
        opset_imports=list(model.opset_import),
        functions=list(model.functions),
    )
    new_model.ir_version = model.ir_version
    new_model.producer_version = model.producer_version
    new_model.domain = model.domain
    new_model.model_version = model.model_version
    new_model.doc_string = model.doc_string
    del new_model.metadata_props[:]
    for prop in model.metadata_props:
        copied = new_model.metadata_props.add()
        copied.key = prop.key
        copied.value = prop.value
    return new_model


def _external_locations(model: onnx.ModelProto) -> tuple[str, ...]:
    locations: set[str] = set()
    for initializer in model.graph.initializer:
        if initializer.data_location != TensorProto.EXTERNAL:
            continue
        values = {entry.key: entry.value for entry in initializer.external_data}
        location = values.get("location")
        if not location:
            raise ValueError(f"external initializer {initializer.name!r} has no location")
        path = Path(location)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"unsafe external data location: {location}")
        locations.add(location)
    return tuple(sorted(locations))


def materialize_external_data(
    source_model_path: Path,
    output_dir: Path,
    locations: Sequence[str],
    mode: str,
) -> None:
    if mode == "none":
        return
    for location in locations:
        source = source_model_path.parent / location
        if not source.exists():
            raise FileNotFoundError(f"external data file not found: {source}")
        destination = output_dir / location
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() or destination.is_symlink():
            destination.unlink()
        if mode == "copy":
            shutil.copy2(source, destination)
        elif mode == "symlink":
            relative = os.path.relpath(source.resolve(), destination.parent.resolve())
            destination.symlink_to(relative)
        else:
            raise ValueError(f"unsupported external data mode: {mode}")


def split_model(
    source_model_path: Path,
    output_dir: Path,
    *,
    split_layer: int = 8,
    hidden_size: int = 2048,
    external_data_mode: str = "symlink",
    hash_external_data: bool = True,
) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    model = onnx.load_model(str(source_model_path), load_external_data=False)
    plan = discover_split_plan(model, split_layer)
    boundary_names = [tensor.name for tensor in plan.boundary_tensors]

    segment0 = extract_submodel(
        model,
        output_names=plan.segment0_outputs,
        hidden_size=hidden_size,
        graph_name=f"unzen-llama-segment-0-layers-0-{split_layer - 1}",
    )
    segment1 = extract_submodel(
        model,
        output_names=plan.segment1_outputs,
        extra_input_names=boundary_names,
        hidden_size=hidden_size,
        graph_name=f"unzen-llama-segment-1-layers-{split_layer}-end",
    )

    locations = tuple(sorted(set(_external_locations(segment0)) | set(_external_locations(segment1))))
    materialize_external_data(source_model_path, output_dir, locations, external_data_mode)

    segment0_path = output_dir / "segment0.onnx"
    segment1_path = output_dir / "segment1.onnx"
    onnx.save_model(segment0, str(segment0_path))
    onnx.save_model(segment1, str(segment1_path))

    onnx.checker.check_model(str(segment0_path), full_check=False)
    onnx.checker.check_model(str(segment1_path), full_check=False)

    external_manifest: list[dict[str, object]] = []
    for location in locations:
        source = source_model_path.parent / location
        entry: dict[str, object] = {
            "location": location,
            "bytes": source.stat().st_size,
        }
        if hash_external_data:
            entry["sha256"] = sha256_file(source)
        external_manifest.append(entry)

    manifest: dict[str, object] = {
        "schemaVersion": "1.0.0",
        "kind": "unzen-real-two-segment-onnx",
        "sourceModel": {
            "path": str(source_model_path),
            "sha256": sha256_file(source_model_path),
            "externalData": external_manifest,
        },
        "splitLayer": split_layer,
        "hiddenSize": hidden_size,
        "boundary": {
            "dtype": "float32",
            "tensorCount": len(plan.boundary_tensors),
            "bytesPerToken": len(plan.boundary_tensors) * hidden_size * 4,
            "tensors": [
                {"name": tensor.name, "producer": tensor.producer_name}
                for tensor in plan.boundary_tensors
            ],
        },
        "segments": [
            {
                "index": 0,
                "path": segment0_path.name,
                "sha256": sha256_file(segment0_path),
                "inputs": [value.name for value in segment0.graph.input],
                "outputs": [value.name for value in segment0.graph.output],
            },
            {
                "index": 1,
                "path": segment1_path.name,
                "sha256": sha256_file(segment1_path),
                "inputs": [value.name for value in segment1.graph.input],
                "outputs": [value.name for value in segment1.graph.output],
            },
        ],
        "logitsOutput": plan.logits_output,
    }
    manifest_path = output_dir / "split-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path, help="Path to model_q4.onnx")
    parser.add_argument("output_dir", type=Path, help="Directory for segment0/segment1 and manifest")
    parser.add_argument("--split-layer", type=int, default=8)
    parser.add_argument("--hidden-size", type=int, default=2048)
    parser.add_argument(
        "--external-data-mode",
        choices=("symlink", "copy", "none"),
        default="symlink",
        help="How referenced external-data files become visible next to split graphs",
    )
    parser.add_argument(
        "--skip-external-digest",
        action="store_true",
        help="Skip SHA-256 of large external data files during exploratory local runs",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    manifest = split_model(
        args.source_model,
        args.output_dir,
        split_layer=args.split_layer,
        hidden_size=args.hidden_size,
        external_data_mode=args.external_data_mode,
        hash_external_data=not args.skip_external_digest,
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
