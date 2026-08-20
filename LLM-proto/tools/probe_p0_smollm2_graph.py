#!/usr/bin/env python3
"""Verify the pinned SmolLM2-135M q4 graph matches the P0 split contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import onnx

from split_llama_1b_onnx import discover_split_plan


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    args = parser.parse_args()

    model = onnx.load_model(str(args.model), load_external_data=False)
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
