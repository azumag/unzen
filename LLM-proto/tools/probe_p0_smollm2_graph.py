#!/usr/bin/env python3
"""Verify the pinned SmolLM2-135M q4 graph matches the P0 split contract."""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import onnx

from source_file_snapshot import read_regular_file_snapshot
from split_llama_1b_onnx import DEFAULT_SOURCE_GRAPH_MAX_BYTES, discover_split_plan


def _load_model_snapshot(path: Path) -> onnx.ModelProto:
    raw, _ = read_regular_file_snapshot(
        path,
        max_bytes=DEFAULT_SOURCE_GRAPH_MAX_BYTES,
        label="P0 model graph",
    )
    return onnx.load_model(io.BytesIO(raw), load_external_data=False)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    args = parser.parse_args()

    model = _load_model_snapshot(args.model)
    plan = discover_split_plan(model, split_layer=15)
    payload = {
        "splitLayer": plan.split_layer,
        "boundaryTensorCount": len(plan.boundary_tensors),
        "boundaryTensors": [
            {"name": item.name, "producer": item.producer_name}
            for item in plan.boundary_tensors
        ],
        "logitsOutput": plan.logits_output,
    }
    if len(plan.boundary_tensors) != 2:
        raise RuntimeError("P0 requires exactly two boundary tensors")
    if not all("model/layers.14/" in item.producer_name.lstrip("/") for item in plan.boundary_tensors):
        raise RuntimeError(f"P0 boundary producers are not both from layer 14: {payload}")
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
