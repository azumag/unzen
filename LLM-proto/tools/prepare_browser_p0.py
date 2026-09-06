#!/usr/bin/env python3
"""Prepare the first real browser-budgeted segmented WebGPU PoC.

The P0 model is intentionally small: onnx-community/SmolLM2-135M-ONNX q4.
Its full q4 external weights are about 182 MB, so a two-way layer split should
comfortably stay inside the preferred per-browser shard ceiling.

This wrapper encodes the product artifact policy and fails closed when the
prepared shards exceed the requested tier. It reuses the generic Llama-shaped
split/repack implementation from prepare_real_split.py.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from prepare_real_split import prepare_real_split

MODEL_ID = "onnx-community/SmolLM2-135M-ONNX"
MODEL_REVISION = "0d747f789bcf79b9b57a4be7f3277b64c185f8ef"
SOURCE_GRAPH_SHA256 = "da1d291b342acafd806b284052053902af82c52121c400789bdf8ab1effdb4c8"
SOURCE_EXTERNAL_DATA_LOCATION = "model_q4.onnx_data"
SOURCE_EXTERNAL_DATA_BYTES = 181_839_104
SOURCE_EXTERNAL_DATA_SHA256 = "89625d22026f0ccba8ba6007b18818647a28c4fc39c392101f0408f089e63c21"
MODEL_CLASS = "SmolLM2-135M"
TOTAL_LAYERS = 30
SPLIT_LAYER = 15
HIDDEN_SIZE = 576
KV_HEADS = 3
HEAD_SIZE = 64

TARGET_BYTES = 200 * 1024 * 1024
PREFERRED_MAX_BYTES = 256 * 1024 * 1024
NORMAL_MAX_BYTES = 512 * 1024 * 1024
ABSOLUTE_MAX_BYTES = 1024 * 1024 * 1024

TIER_LIMITS = {
    "preferred": PREFERRED_MAX_BYTES,
    "normal": NORMAL_MAX_BYTES,
    "absolute": ABSOLUTE_MAX_BYTES,
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_pinned_source_graph(source_model_path: Path) -> str:
    if not source_model_path.is_file():
        raise FileNotFoundError(f"P0 source graph not found: {source_model_path}")
    observed = sha256_file(source_model_path)
    if observed != SOURCE_GRAPH_SHA256:
        raise RuntimeError(
            "SmolLM2 P0 source graph does not match the pinned artifact: "
            f"revision={MODEL_REVISION}, expected={SOURCE_GRAPH_SHA256}, observed={observed}"
        )
    return observed


def verify_pinned_source_external_data(manifest: dict[str, object]) -> None:
    source_model = manifest.get("sourceModel")
    if not isinstance(source_model, dict):
        raise RuntimeError("generated P0 manifest is missing sourceModel")
    entries = source_model.get("externalData")
    if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
        raise RuntimeError("SmolLM2 P0 source must declare exactly one external-data file")
    entry = entries[0]
    expected = {
        "location": SOURCE_EXTERNAL_DATA_LOCATION,
        "bytes": SOURCE_EXTERNAL_DATA_BYTES,
        "sha256": SOURCE_EXTERNAL_DATA_SHA256,
    }
    observed = {key: entry.get(key) for key in expected}
    if observed != expected:
        raise RuntimeError(
            "SmolLM2 P0 source external data does not match the pinned artifact: "
            f"revision={MODEL_REVISION}, expected={expected}, observed={observed}"
        )


def _artifact_bytes(segment: dict[str, object], output_dir: Path) -> int:
    graph_path = output_dir / str(segment["path"])
    total = graph_path.stat().st_size
    for entry in segment.get("externalData", []):
        total += int(entry["bytes"])
    return total


def _tier(byte_size: int) -> str:
    if byte_size <= PREFERRED_MAX_BYTES:
        return "preferred"
    if byte_size <= NORMAL_MAX_BYTES:
        return "normal"
    if byte_size <= ABSOLUTE_MAX_BYTES:
        return "degraded"
    return "rejected"


def apply_browser_budget(
    manifest: dict[str, object],
    output_dir: Path,
    *,
    require_tier: str = "preferred",
) -> dict[str, object]:
    if require_tier not in TIER_LIMITS:
        raise ValueError(f"unsupported required tier: {require_tier}")

    segment_reports: list[dict[str, object]] = []
    maximum = 0
    for segment in manifest["segments"]:
        byte_size = _artifact_bytes(segment, output_dir)
        maximum = max(maximum, byte_size)
        report = {
            "index": int(segment["index"]),
            "artifactBytes": byte_size,
            "tier": _tier(byte_size),
            "targetDeltaBytes": byte_size - TARGET_BYTES,
        }
        segment["browserArtifactBytes"] = byte_size
        segment["browserArtifactTier"] = report["tier"]
        segment_reports.append(report)

    policy = {
        "targetBytes": TARGET_BYTES,
        "preferredMaxBytes": PREFERRED_MAX_BYTES,
        "normalMaxBytes": NORMAL_MAX_BYTES,
        "absoluteMaxBytes": ABSOLUTE_MAX_BYTES,
        "requiredTier": require_tier,
        "requiredMaxBytes": TIER_LIMITS[require_tier],
        "maximumSegmentArtifactBytes": maximum,
        "segments": segment_reports,
    }
    manifest["browserArtifactBudget"] = policy

    oversized = [
        report
        for report in segment_reports
        if int(report["artifactBytes"]) > TIER_LIMITS[require_tier]
    ]
    if oversized:
        detail = ", ".join(
            f"segment {entry['index']}={entry['artifactBytes']} bytes ({entry['tier']})"
            for entry in oversized
        )
        raise RuntimeError(
            f"browser artifact budget exceeded for required tier {require_tier}: {detail}; "
            "increase segment count instead of accepting a larger browser shard"
        )
    return manifest


def prepare_browser_p0(
    source_model_path: Path,
    output_dir: Path,
    *,
    require_tier: str = "preferred",
    hash_source_external_data: bool = True,
) -> dict[str, object]:
    source_graph_sha256 = verify_pinned_source_graph(source_model_path)
    manifest = prepare_real_split(
        source_model_path,
        output_dir,
        split_layer=SPLIT_LAYER,
        hidden_size=HIDDEN_SIZE,
        hash_source_external_data=hash_source_external_data,
    )
    if manifest.get("sourceModel", {}).get("sha256") != source_graph_sha256:
        raise RuntimeError("generated manifest sourceModel.sha256 drifted from the pinned P0 source graph")
    if hash_source_external_data:
        verify_pinned_source_external_data(manifest)
    manifest["modelProfile"] = {
        "modelId": MODEL_ID,
        "revision": MODEL_REVISION,
        "modelClass": MODEL_CLASS,
        "quantization": "q4",
        "totalLayers": TOTAL_LAYERS,
        "splitLayer": SPLIT_LAYER,
        "runtimeHints": {
            "hiddenSize": HIDDEN_SIZE,
            "kvHeads": KV_HEADS,
            "headSize": HEAD_SIZE,
        },
    }
    apply_browser_budget(manifest, output_dir, require_tier=require_tier)
    manifest_path = output_dir / "split-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path, help="Path to SmolLM2-135M q4 model_q4.onnx")
    parser.add_argument("output_dir", type=Path, help="Output directory for browser-ready shards")
    parser.add_argument(
        "--require-tier",
        choices=tuple(TIER_LIMITS),
        default="preferred",
        help="Fail if any browser shard exceeds this tier (P0 default: preferred <=256 MiB)",
    )
    parser.add_argument(
        "--skip-source-external-digest",
        action="store_true",
        help=(
            "Exploratory only: skip source external-data provenance hashing. "
            "The browser P0 runner rejects manifests without the pinned source digest."
        ),
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    manifest = prepare_browser_p0(
        args.source_model,
        args.output_dir,
        require_tier=args.require_tier,
        hash_source_external_data=not args.skip_source_external_digest,
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
