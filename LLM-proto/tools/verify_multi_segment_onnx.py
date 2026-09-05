#!/usr/bin/env python3
"""Compare a full ONNX model with a budgeted N-segment split on one machine.

The verifier consumes ``tools/multi_segment_onnx.py`` output directly. Segment
sessions are created and released one at a time so a 1B-class full model and all
browser shards are never resident simultaneously. Each intermediate boundary is
relayed by the exact tensor names recorded in ``split-manifest.json``.
"""

from __future__ import annotations

import argparse
import gc
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Sequence

import numpy as np
import onnxruntime as ort

from verify_split_onnx import (
    _last_token_argmax,
    build_feeds,
    compare_logits,
    parse_token_ids,
)


MANIFEST_KIND = "unzen-budgeted-multi-segment-onnx"
ARTIFACT_LAYOUT = "per-segment-external-data"


def _safe_relative_path(root: Path, raw: object) -> Path:
    value = str(raw or "")
    if not value:
        raise ValueError("segment path must be a non-empty relative path")
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or ".." in posix.parts
        or ".." in windows.parts
    ):
        raise ValueError(f"unsafe segment path in split manifest: {value}")
    resolved_root = root.resolve()
    resolved = (root / Path(value)).resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise ValueError(f"segment path escapes split manifest directory: {value}")
    return resolved


def _string_names(raw: object, *, field: str) -> tuple[str, ...]:
    if not isinstance(raw, list):
        raise ValueError(f"{field} must be an array")
    values = tuple(str(value) for value in raw)
    if any(not value for value in values):
        raise ValueError(f"{field} contains an empty tensor name")
    if len(set(values)) != len(values):
        raise ValueError(f"{field} contains duplicate tensor names")
    return values


def validate_multi_segment_manifest(
    manifest: dict[str, object],
    manifest_dir: Path,
) -> dict[str, object]:
    """Fail closed on the execution contract before creating any ORT session."""

    if manifest.get("kind") != MANIFEST_KIND:
        raise ValueError(f"unexpected split manifest kind: {manifest.get('kind')}")
    if manifest.get("artifactLayout") != ARTIFACT_LAYOUT:
        raise ValueError(
            "multi-segment verifier requires per-segment external data; "
            f"got {manifest.get('artifactLayout')!r}"
        )

    raw_segments = manifest.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        raise ValueError("split manifest must contain at least one segment")

    segments: list[dict[str, object]] = []
    expected_start = 0
    for expected_index, raw_segment in enumerate(raw_segments):
        if not isinstance(raw_segment, dict):
            raise ValueError(f"segment {expected_index} must be an object")
        index = int(raw_segment.get("index", -1))
        start = int(raw_segment.get("startLayer", -1))
        end = int(raw_segment.get("endLayer", -1))
        if index != expected_index:
            raise ValueError(
                f"segment indices must cover 0..n-1; expected {expected_index}, got {index}"
            )
        if start != expected_start or end <= start:
            raise ValueError(
                f"segments must be contiguous non-empty layer spans; "
                f"segment {index} is [{start}, {end}), expected start {expected_start}"
            )
        path = _safe_relative_path(manifest_dir, raw_segment.get("path"))
        if not path.is_file():
            raise FileNotFoundError(f"segment artifact not found: {path}")
        inputs = _string_names(raw_segment.get("inputs", []), field=f"segments[{index}].inputs")
        outputs = _string_names(raw_segment.get("outputs", []), field=f"segments[{index}].outputs")
        segments.append(
            {
                "index": index,
                "startLayer": start,
                "endLayer": end,
                "path": path,
                "inputs": inputs,
                "outputs": outputs,
            }
        )
        expected_start = end

    raw_boundaries = manifest.get("boundaries")
    if not isinstance(raw_boundaries, list):
        raise ValueError("split manifest boundaries must be an array")
    if len(raw_boundaries) != max(0, len(segments) - 1):
        raise ValueError(
            f"expected {max(0, len(segments) - 1)} boundaries for {len(segments)} segments; "
            f"found {len(raw_boundaries)}"
        )

    boundaries: list[dict[str, object]] = []
    for index, raw_boundary in enumerate(raw_boundaries):
        if not isinstance(raw_boundary, dict):
            raise ValueError(f"boundary {index} must be an object")
        left = segments[index]
        right = segments[index + 1]
        after = int(raw_boundary.get("afterLayer", -1))
        before = int(raw_boundary.get("beforeLayer", -1))
        if after != int(left["endLayer"]) - 1 or before != int(right["startLayer"]):
            raise ValueError(
                f"boundary {index} does not match adjacent segment spans: "
                f"after={after}, before={before}"
            )
        raw_tensors = raw_boundary.get("tensors")
        if not isinstance(raw_tensors, list) or not raw_tensors:
            raise ValueError(f"boundary {index} must contain at least one tensor")
        names = tuple(str(item.get("name", "")) for item in raw_tensors if isinstance(item, dict))
        if len(names) != len(raw_tensors) or any(not name for name in names):
            raise ValueError(f"boundary {index} contains an invalid tensor entry")
        if len(set(names)) != len(names):
            raise ValueError(f"boundary {index} contains duplicate tensor names")
        missing_left = sorted(set(names) - set(left["outputs"]))
        missing_right = sorted(set(names) - set(right["inputs"]))
        if missing_left or missing_right:
            raise ValueError(
                f"boundary {index} tensor contract mismatch: "
                f"missingFromProducer={missing_left}, missingFromConsumer={missing_right}"
            )
        boundaries.append({"names": names, "afterLayer": after, "beforeLayer": before})

    raw_plan = manifest.get("splitPlan")
    if not isinstance(raw_plan, dict):
        raise ValueError("split manifest splitPlan must be an object")
    expected_cuts = [int(segment["endLayer"]) for segment in segments[:-1]]
    raw_cuts = raw_plan.get("cutLayers")
    if not isinstance(raw_cuts, list) or [int(value) for value in raw_cuts] != expected_cuts:
        raise ValueError(
            f"splitPlan.cutLayers must match segment boundaries: expected {expected_cuts}, got {raw_cuts}"
        )

    logits_candidates = [
        name
        for name in segments[-1]["outputs"]
        if name == "logits" or name.endswith("/logits")
    ]
    if len(logits_candidates) != 1:
        raise ValueError(
            f"final segment must expose exactly one logits output; found {logits_candidates}"
        )

    return {
        "segments": tuple(segments),
        "boundaries": tuple(boundaries),
        "logitsOutput": logits_candidates[0],
    }


def _boundary_report(
    *,
    after_layer: int,
    before_layer: int,
    names: Sequence[str],
    values: Sequence[np.ndarray],
) -> dict[str, object]:
    tensors = [
        {
            "name": name,
            "shape": list(value.shape),
            "dtype": str(value.dtype),
            "bytes": int(value.nbytes),
        }
        for name, value in zip(names, values, strict=True)
    ]
    return {
        "afterLayer": after_layer,
        "beforeLayer": before_layer,
        "tensors": tensors,
        "bytes": sum(int(value.nbytes) for value in values),
    }


def verify_multi_split(
    full_model_path: Path,
    manifest_path: Path,
    token_ids: Sequence[int],
    *,
    provider: str = "CPUExecutionProvider",
    kv_heads: int = 8,
    head_size: int = 64,
    atol: float = 1e-4,
    rtol: float = 1e-4,
) -> dict[str, object]:
    if not token_ids:
        raise ValueError("at least one token ID is required")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    contract = validate_multi_segment_manifest(manifest, manifest_path.parent)
    segments = contract["segments"]
    boundaries = contract["boundaries"]
    logits_name = str(contract["logitsOutput"])
    providers = [provider]

    full_session = ort.InferenceSession(str(full_model_path), providers=providers)
    full_feeds = build_feeds(
        full_session,
        token_ids,
        kv_heads=kv_heads,
        head_size=head_size,
    )
    full_logits = full_session.run([logits_name], full_feeds)[0]
    del full_feeds
    del full_session
    gc.collect()

    boundary_values: dict[str, np.ndarray] = {}
    boundary_reports: list[dict[str, object]] = []
    split_logits: np.ndarray | None = None

    for index, segment in enumerate(segments):
        session = ort.InferenceSession(str(segment["path"]), providers=providers)
        feeds = build_feeds(
            session,
            token_ids,
            boundary=boundary_values,
            kv_heads=kv_heads,
            head_size=head_size,
        )
        if index < len(boundaries):
            boundary = boundaries[index]
            names = boundary["names"]
            values = session.run(list(names), feeds)
            boundary_values = dict(zip(names, values, strict=True))
            boundary_reports.append(
                _boundary_report(
                    after_layer=int(boundary["afterLayer"]),
                    before_layer=int(boundary["beforeLayer"]),
                    names=names,
                    values=values,
                )
            )
        else:
            split_logits = session.run([logits_name], feeds)[0]
        del feeds
        del session
        gc.collect()

    if split_logits is None:
        raise AssertionError("final segment did not produce logits")

    comparison = compare_logits(full_logits, split_logits, atol, rtol)
    report: dict[str, object] = {
        "schemaVersion": "1.0.0",
        "kind": "unzen-budgeted-multi-segment-same-machine-verification",
        "provider": provider,
        "inputTokenIds": list(token_ids),
        "segmentCount": len(segments),
        "cutLayers": [int(segment["endLayer"]) for segment in segments[:-1]],
        "boundaries": boundary_reports,
        "boundaryBytes": sum(int(boundary["bytes"]) for boundary in boundary_reports),
        "comparison": comparison,
        "fullTop1TokenId": _last_token_argmax(full_logits),
        "splitTop1TokenId": _last_token_argmax(split_logits),
        "sequentialSessionLoading": True,
    }
    report["status"] = (
        "pass"
        if comparison["matches"]
        and report["fullTop1TokenId"] == report["splitTop1TokenId"]
        else "fail"
    )
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full-model", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--input-ids", required=True, help="Comma-separated token IDs")
    parser.add_argument("--provider", default="CPUExecutionProvider")
    parser.add_argument("--kv-heads", type=int, default=8)
    parser.add_argument("--head-size", type=int, default=64)
    parser.add_argument("--atol", type=float, default=1e-4)
    parser.add_argument("--rtol", type=float, default=1e-4)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = verify_multi_split(
        args.full_model,
        args.manifest,
        parse_token_ids(args.input_ids),
        provider=args.provider,
        kv_heads=args.kv_heads,
        head_size=args.head_size,
        atol=args.atol,
        rtol=args.rtol,
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
