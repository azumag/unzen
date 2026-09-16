#!/usr/bin/env python3
"""Prepare budgeted ONNX shards in staging and publish the manifest last."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

from multi_segment_onnx import (
    _generated_artifact_paths,
    _preflight_generated_artifact_collisions,
    _preflight_generated_artifact_destinations,
    _validate_budget_options,
    prepare_budgeted_multi_split,
)
from prepare_browser_p0 import PREFERRED_MAX_BYTES


def _require_generated_layout(manifest: dict[str, object]) -> tuple[dict[str, object], ...]:
    """Snapshot the generator-owned paths that are eligible for publication."""

    raw_segments = manifest.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        raise RuntimeError("generated split manifest must contain a non-empty segments array")

    segments: list[dict[str, object]] = []
    for expected_index, raw_segment in enumerate(raw_segments):
        if not isinstance(raw_segment, dict):
            raise RuntimeError(f"generated segment {expected_index} must be an object")
        index = raw_segment.get("index")
        path = raw_segment.get("path")
        external_data = raw_segment.get("externalData")
        if index != expected_index:
            raise RuntimeError(
                f"generated segment index mismatch: expected {expected_index}, found {index!r}"
            )
        expected_graph = f"segment{expected_index}.onnx"
        if path != expected_graph:
            raise RuntimeError(
                f"generated segment {expected_index} path must be {expected_graph!r}; found {path!r}"
            )
        if not isinstance(external_data, list):
            raise RuntimeError(
                f"generated segment {expected_index} externalData must be an array"
            )
        if len(external_data) > 1:
            raise RuntimeError(
                f"generated segment {expected_index} must use at most one external-data file"
            )
        if external_data:
            external = external_data[0]
            if not isinstance(external, dict):
                raise RuntimeError(
                    f"generated segment {expected_index} externalData[0] must be an object"
                )
            expected_external = f"segment{expected_index}.onnx_data"
            if external.get("location") != expected_external:
                raise RuntimeError(
                    f"generated segment {expected_index} external-data location must be "
                    f"{expected_external!r}; found {external.get('location')!r}"
                )
        segments.append(dict(raw_segment))
    return tuple(segments)


def _source_artifacts_from_manifest(
    source_model_path: Path,
    manifest: dict[str, object],
) -> set[Path]:
    """Reconstruct the immutable source set already validated by the generator."""

    source_model = manifest.get("sourceModel")
    if not isinstance(source_model, dict):
        raise RuntimeError("generated split manifest must contain sourceModel metadata")
    raw_external = source_model.get("externalData")
    if not isinstance(raw_external, list):
        raise RuntimeError("generated split manifest sourceModel.externalData must be an array")

    sources = {source_model_path.resolve(strict=True)}
    for index, raw_entry in enumerate(raw_external):
        if not isinstance(raw_entry, dict):
            raise RuntimeError(
                f"generated source externalData[{index}] must be an object"
            )
        location = raw_entry.get("location")
        if not isinstance(location, str) or not location:
            raise RuntimeError(
                f"generated source externalData[{index}].location must be a non-empty string"
            )
        sources.add((source_model_path.parent / location).resolve(strict=True))
    return sources


def _publish_staged_split(
    *,
    staged_dir: Path,
    output_dir: Path,
    source_model_path: Path,
    manifest: dict[str, object],
) -> None:
    """Publish a fully validated staged split with the final manifest as commit marker.

    Multi-file replacement cannot be globally atomic. The safety invariant is
    therefore fail-closed: the old manifest is removed before the first final
    artifact mutation, and the new manifest is moved into place only after all
    graph/external-data mutations succeed. A publication failure may leave a
    mixed artifact directory, but it cannot leave a stale manifest claiming the
    mixed files are a coherent published split.
    """

    segments = _require_generated_layout(manifest)
    final_artifacts = _generated_artifact_paths(output_dir, len(segments))
    source_artifacts = _source_artifacts_from_manifest(source_model_path, manifest)
    _preflight_generated_artifact_collisions(source_artifacts, final_artifacts)
    _preflight_generated_artifact_destinations(final_artifacts)

    staged_manifest = staged_dir / "split-manifest.json"
    if not staged_manifest.is_file():
        raise RuntimeError("staged split-manifest.json is missing")
    for index, segment in enumerate(segments):
        graph = staged_dir / str(segment["path"])
        if not graph.is_file():
            raise RuntimeError(f"staged segment graph is missing: {graph}")
        external_data = segment["externalData"]
        if external_data:
            external = staged_dir / str(external_data[0]["location"])
            if not external.is_file():
                raise RuntimeError(f"staged segment external data is missing: {external}")

    final_manifest = output_dir / "split-manifest.json"
    if final_manifest.exists():
        final_manifest.unlink()

    for index, segment in enumerate(segments):
        staged_graph = staged_dir / str(segment["path"])
        final_graph = output_dir / staged_graph.name
        os.replace(staged_graph, final_graph)

        staged_external = staged_dir / f"segment{index}.onnx_data"
        final_external = output_dir / staged_external.name
        external_data = segment["externalData"]
        if external_data:
            os.replace(staged_external, final_external)
        elif final_external.exists():
            final_external.unlink()

    os.replace(staged_manifest, final_manifest)


def prepare_budgeted_multi_split_atomic(
    source_model_path: Path,
    output_dir: Path,
    *,
    hidden_size: int = 2048,
    target_bytes: int,
    preferred_max_bytes: int,
    hash_source_external_data: bool = True,
) -> dict[str, object]:
    """Prepare in an isolated staging directory, then publish fail-closed."""

    _validate_budget_options(
        hidden_size=hidden_size,
        target_bytes=target_bytes,
        preferred_max_bytes=preferred_max_bytes,
    )
    output_dir = output_dir.expanduser().absolute()
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix=".unzen-budgeted-split-stage-",
        dir=output_dir,
    ) as staging:
        staged_dir = Path(staging)
        manifest = prepare_budgeted_multi_split(
            source_model_path,
            staged_dir,
            hidden_size=hidden_size,
            target_bytes=target_bytes,
            preferred_max_bytes=preferred_max_bytes,
            hash_source_external_data=hash_source_external_data,
        )
        _publish_staged_split(
            staged_dir=staged_dir,
            output_dir=output_dir,
            source_model_path=source_model_path,
            manifest=manifest,
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
    manifest = prepare_budgeted_multi_split_atomic(
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
