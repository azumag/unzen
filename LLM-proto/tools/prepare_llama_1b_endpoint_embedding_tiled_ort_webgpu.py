#!/usr/bin/env python3
"""Prepare complete diagnostic tiled embedding inputs for ORT Web/WebGPU.

Issue #223 still requires an explicit architecture decision before any endpoint
layout is adopted. This helper only prepares the remaining browser/WebGPU S0
experiment for the already-measured 4-physical / 8-execution-tile candidate.
It materializes the four pinned preferred payloads, emits the two distinct
embedding Gather graph variants needed by alternating zero/non-zero byte
offsets, and records exact token routing for both ends of every vocabulary tile.

The browser harness computes its reference directly from the SHA-256-verified
payload bytes. Preparation does not select the candidate layout, alter runtime
or manifest semantics, or prove decoder/KV/checkpoint full-model equivalence.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import onnx

import prepare_llama_1b_endpoint_poststage_tiled_ort_webgpu as poststage_webgpu
import prepare_llama_1b_endpoint_preferred_tile_ort_webgpu as preferred_webgpu
import probe_llama_1b_endpoint_embedding_composition_ort_cpu as embedding_cpu
import probe_llama_1b_endpoint_layout_candidates as layout_probe
import probe_llama_1b_endpoint_preferred_tile_ort_cpu as preferred_cpu

REPORT_KIND = "unzen-pinned-llama-1b-endpoint-embedding-tiled-ort-webgpu-preparation"
REPORT_SCHEMA_VERSION = "1.0.0"
RUNTIME_REPORT_KIND = "unzen-pinned-llama-1b-endpoint-embedding-tiled-ort-webgpu-runtime"
PHYSICAL_ARTIFACT_COUNT = 4
EXECUTION_TILE_COUNT = 8
ROWS_PER_TILE = 16_032
TILE_BYTES = 131_334_144
PHYSICAL_BYTES = 262_668_288
NON_ZERO_TILE_OFFSET = TILE_BYTES
SOURCE_GRAPH_BYTES = 149_112
SOURCE_GRAPH_FILE = "model_q4.onnx"
SOURCE_EXTERNAL_FILE = "model_q4.onnx_data"
GRAPH_EXTERNAL_DATA_PATH = "payload-0000.bin"
ORT_WEB_VERSION = preferred_webgpu.ORT_WEB_VERSION

EXPECTED_GRAPH_VARIANTS = {
    "offset0": {
        "file": "embedding-offset-0.onnx",
        "artifactByteOffset": 0,
        "bytes": 260,
        "sha256": "70a56611e458eb6af8333329424756275aa5ad6b08467fa51912532867b6ce50",
    },
    "offsetHalf": {
        "file": "embedding-offset-131334144.onnx",
        "artifactByteOffset": NON_ZERO_TILE_OFFSET,
        "bytes": 268,
        "sha256": "bf43c241540197eb23e9d0768da23e4e81cbcdf80b145c93a91b5ee508b9d52a",
    },
}


def _require_int(value: object, *, field: str, positive: bool = False) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise RuntimeError(f"{field} must be an integer")
    if positive and value <= 0:
        raise RuntimeError(f"{field} must be positive")
    if not positive and value < 0:
        raise RuntimeError(f"{field} must be non-negative")
    return value


def _write_graph_variants(output_dir: Path, *, hidden_size: int) -> dict[str, dict[str, object]]:
    result: dict[str, dict[str, object]] = {}
    for key, expected in EXPECTED_GRAPH_VARIANTS.items():
        offset = int(expected["artifactByteOffset"])
        path = output_dir / str(expected["file"])
        model = preferred_webgpu.build_probe_model(
            mode="embedding",
            rows=ROWS_PER_TILE,
            hidden_size=hidden_size,
            offset=offset,
            length=TILE_BYTES,
        )
        onnx.save(model, path)
        onnx.checker.check_model(str(path), full_check=True)
        info = {
            "file": path.name,
            "artifactByteOffset": offset,
            "bytes": path.stat().st_size,
            "sha256": preferred_webgpu._sha256_file(path),
        }
        if info != expected:
            path.unlink(missing_ok=True)
            raise RuntimeError(
                f"embedding graph variant {key} drifted: expected {expected!r}, got {info!r}"
            )
        result[key] = info
    return result


def _validate_candidate(layout: dict[str, object]) -> tuple[int, list[dict[str, object]], list[dict[str, object]]]:
    if (
        layout.get("kind") != layout_probe.REPORT_KIND
        or layout.get("schemaVersion") != layout_probe.REPORT_SCHEMA_VERSION
        or layout.get("status") != "pass"
        or layout.get("decisionStatus") != "diagnostic-only"
    ):
        raise RuntimeError("upstream endpoint layout contract drift")
    row_bytes = _require_int(layout.get("rowBytes"), field="layout.rowBytes", positive=True)
    if row_bytes % embedding_cpu.FLOAT32_BYTES:
        raise RuntimeError("layout.rowBytes must describe float32 rows")
    hidden_size = row_bytes // embedding_cpu.FLOAT32_BYTES
    if hidden_size != embedding_cpu.HIDDEN_SIZE:
        raise RuntimeError("pinned hidden size drifted")

    candidates = layout.get("candidates")
    if not isinstance(candidates, list):
        raise RuntimeError("layout candidates missing")
    matches = [
        item
        for item in candidates
        if isinstance(item, dict)
        and item.get("physicalArtifactCount") == PHYSICAL_ARTIFACT_COUNT
    ]
    if len(matches) != 1:
        raise RuntimeError("expected exactly one pinned 4-way candidate")
    physical = matches[0].get("physicalArtifacts")
    tiles = matches[0].get("executionTiles")
    if not isinstance(physical, list) or len(physical) != PHYSICAL_ARTIFACT_COUNT:
        raise RuntimeError("preferred physical artifact geometry drifted")
    if not isinstance(tiles, list) or len(tiles) != EXECUTION_TILE_COUNT:
        raise RuntimeError("preferred execution tile geometry drifted")
    if not all(isinstance(item, dict) for item in physical + tiles):
        raise RuntimeError("preferred candidate entries must be objects")
    return hidden_size, physical, tiles


def prepare(source_model: Path, source_external_data: Path, output_dir: Path) -> dict[str, object]:
    source_model = source_model.resolve()
    source_external_data = source_external_data.resolve()
    if source_model.name != SOURCE_GRAPH_FILE:
        raise RuntimeError(f"pinned source graph file must be {SOURCE_GRAPH_FILE}")
    if source_external_data.name != SOURCE_EXTERNAL_FILE:
        raise RuntimeError(f"pinned source external-data file must be {SOURCE_EXTERNAL_FILE}")

    layout = layout_probe.build_report(source_model)
    hidden_size, physical, tiles = _validate_candidate(layout)
    inferred_source, source_weight_offset, source_weight_length = embedding_cpu._source_embedding_contract(
        source_model, layout
    )
    if inferred_source != source_external_data:
        raise RuntimeError("explicit source external-data path does not match source graph location")
    if source_weight_offset != 0 or source_weight_length != embedding_cpu.SOURCE_WEIGHT_BYTES:
        raise RuntimeError("pinned embedding source range drifted")
    if source_model.stat().st_size != SOURCE_GRAPH_BYTES:
        raise RuntimeError("pinned source graph byte length drifted")

    source_identity = layout.get("pinnedSourceExternalDataIdentity")
    if not isinstance(source_identity, dict):
        raise RuntimeError("pinned source external-data identity missing")
    if (
        source_identity.get("bytes") != preferred_webgpu.PINNED_EXTERNAL_DATA_BYTES
        or source_identity.get("sha256") != preferred_webgpu.PINNED_EXTERNAL_DATA_SHA256
    ):
        raise RuntimeError("pinned source external-data identity drifted")

    poststage_webgpu._ensure_empty_output_dir(output_dir)
    created: list[Path] = []
    source_fd = -1
    source_path_identity: tuple[int, int, int, int, int] | None = None
    try:
        source_fd, verified_source, source_path_identity = preferred_cpu._open_pinned_payload(
            source_external_data,
            expected_bytes=preferred_webgpu.PINNED_EXTERNAL_DATA_BYTES,
            expected_sha256=preferred_webgpu.PINNED_EXTERNAL_DATA_SHA256,
        )
        verified_source["role"] = "pinned-source-external-data"

        physical_by_index: dict[int, dict[str, object]] = {}
        for item in physical:
            index = _require_int(item.get("index"), field="physical.index")
            if index in physical_by_index:
                raise RuntimeError(f"duplicate physical artifact index {index}")
            physical_by_index[index] = item
        if sorted(physical_by_index) != list(range(PHYSICAL_ARTIFACT_COUNT)):
            raise RuntimeError("physical artifacts must be indexed 0..3")

        manifest_artifacts: list[dict[str, object]] = []
        for index in range(PHYSICAL_ARTIFACT_COUNT):
            item = physical_by_index[index]
            source_offset = _require_int(
                item.get("sourceOffsetBytes"), field=f"physical[{index}].sourceOffsetBytes"
            )
            source_end = _require_int(
                item.get("sourceEndOffsetBytesExclusive"),
                field=f"physical[{index}].sourceEndOffsetBytesExclusive",
                positive=True,
            )
            byte_length = _require_int(
                item.get("byteLength"), field=f"physical[{index}].byteLength", positive=True
            )
            if byte_length != PHYSICAL_BYTES or source_end - source_offset != byte_length:
                raise RuntimeError(f"physical artifact {index} geometry drifted")
            expected_sha = preferred_cpu.PINNED_PREFERRED_PAYLOAD_SHA256.get(index)
            if expected_sha is None:
                raise RuntimeError(f"missing pinned hash for physical artifact {index}")
            payload_path = output_dir / f"payload-{index:04d}.bin"
            digest = poststage_webgpu._copy_fd_range(
                source_fd,
                source_offset=source_offset,
                length=byte_length,
                destination=payload_path,
                expected_sha256=expected_sha,
            )
            created.append(payload_path)
            manifest_artifacts.append(
                {
                    "index": index,
                    "file": payload_path.name,
                    "bytes": byte_length,
                    "sha256": digest,
                    "sourceOffsetBytes": source_offset,
                    "sourceEndOffsetBytesExclusive": source_end,
                }
            )

        graph_variants = _write_graph_variants(output_dir, hidden_size=hidden_size)
        created.extend(output_dir / str(info["file"]) for info in graph_variants.values())

        manifest_tiles: list[dict[str, object]] = []
        expected_start = 0
        for tile_index, tile in enumerate(tiles):
            if tile.get("tileIndex") != tile_index or tile.get("startRow") != expected_start:
                raise RuntimeError("execution tiles must be ordered and contiguous")
            row_count = _require_int(tile.get("rowCount"), field=f"tile[{tile_index}].rowCount", positive=True)
            end_row = _require_int(
                tile.get("endRowExclusive"), field=f"tile[{tile_index}].endRowExclusive", positive=True
            )
            if row_count != ROWS_PER_TILE or end_row != expected_start + ROWS_PER_TILE:
                raise RuntimeError(f"tile {tile_index} row geometry drifted")
            slices = tile.get("physicalSlices")
            if not isinstance(slices, list) or len(slices) != 1 or not isinstance(slices[0], dict):
                raise RuntimeError(f"tile {tile_index} must map to one physical slice")
            sl = slices[0]
            artifact_index = _require_int(
                sl.get("physicalArtifactIndex"), field=f"tile[{tile_index}].physicalArtifactIndex"
            )
            offset = _require_int(
                sl.get("artifactByteOffset"), field=f"tile[{tile_index}].artifactByteOffset"
            )
            byte_length = _require_int(
                sl.get("byteLength"), field=f"tile[{tile_index}].byteLength", positive=True
            )
            expected_artifact = tile_index // 2
            expected_offset = 0 if tile_index % 2 == 0 else NON_ZERO_TILE_OFFSET
            if artifact_index != expected_artifact or offset != expected_offset or byte_length != TILE_BYTES:
                raise RuntimeError(f"tile {tile_index} physical slice geometry drifted")
            variant = "offset0" if offset == 0 else "offsetHalf"
            positions = [tile_index * 2, tile_index * 2 + 1]
            global_ids = [expected_start, end_row - 1]
            manifest_tiles.append(
                {
                    "tileIndex": tile_index,
                    "startRow": expected_start,
                    "endRowExclusive": end_row,
                    "rowCount": row_count,
                    "physicalArtifactIndex": artifact_index,
                    "artifactByteOffset": offset,
                    "byteLength": byte_length,
                    "graphVariant": variant,
                    "positions": positions,
                    "globalTokenIds": global_ids,
                    "localTokenIds": [0, ROWS_PER_TILE - 1],
                }
            )
            expected_start = end_row
        if expected_start != embedding_cpu.VOCAB_ROWS:
            raise RuntimeError("execution tiles do not cover the full vocabulary")
        token_ids = [token for tile in manifest_tiles for token in tile["globalTokenIds"]]
        if token_ids != embedding_cpu.TOKEN_IDS:
            raise RuntimeError("browser token routing drifted from pinned CPU composition probe")

        if source_path_identity is None:
            raise RuntimeError("source external-data identity was not pinned")
        preferred_cpu._assert_payload_path_identity(
            source_external_data, pinned_identity=source_path_identity
        )

        manifest = {
            "schemaVersion": REPORT_SCHEMA_VERSION,
            "kind": REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "runtimeReportKind": RUNTIME_REPORT_KIND,
            "sourceGraphSha256": layout.get("sourceGraphSha256"),
            "verifiedPinnedSourceGraph": {
                "fileName": SOURCE_GRAPH_FILE,
                "byteLength": SOURCE_GRAPH_BYTES,
                "sha256": layout.get("sourceGraphSha256"),
                "role": "pinned-source-graph",
            },
            "sourceExternalData": {
                "fileName": SOURCE_EXTERNAL_FILE,
                "bytes": verified_source["byteLength"],
                "sha256": verified_source["sha256"],
            },
            "embeddingInitializer": {
                "name": embedding_cpu.EMBEDDING_INITIALIZER,
                "rows": embedding_cpu.VOCAB_ROWS,
                "hiddenSize": hidden_size,
                "sourceOffsetBytes": source_weight_offset,
                "byteLength": source_weight_length,
            },
            "physicalArtifactCount": PHYSICAL_ARTIFACT_COUNT,
            "executionTileCount": EXECUTION_TILE_COUNT,
            "rows": embedding_cpu.VOCAB_ROWS,
            "hiddenSize": hidden_size,
            "onnxruntimeWebVersion": ORT_WEB_VERSION,
            "graphExternalDataPath": GRAPH_EXTERNAL_DATA_PATH,
            "graphVariants": graph_variants,
            "physicalArtifacts": manifest_artifacts,
            "tokenIds": token_ids,
            "tiles": manifest_tiles,
            "sequentialExecution": {
                "physicalArtifactOrder": list(range(PHYSICAL_ARTIFACT_COUNT)),
                "tilesPerPhysicalArtifact": 2,
                "maximumWholePhysicalPayloadBytesPerStep": PHYSICAL_BYTES,
                "totalPhysicalPayloadBytesVerifiedAcrossRun": PHYSICAL_BYTES * PHYSICAL_ARTIFACT_COUNT,
            },
            "conclusion": (
                "Prepared a diagnostic-only complete browser embedding experiment over all eight "
                "vocabulary tiles and four independently verified preferred physical payloads. "
                "The browser reference is reconstructed directly from verified payload bytes. "
                "This does not select the 4-way/8-way architecture, define production runtime/cache "
                "semantics, or prove decoder/KV/checkpoint full-model staged equivalence."
            ),
        }
        manifest_path = output_dir / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        created.append(manifest_path)
        return manifest
    except Exception:
        for path in reversed(created):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    finally:
        if source_fd >= 0:
            os.close(source_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path)
    parser.add_argument("source_external_data", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    report = prepare(
        args.source_model.absolute(),
        args.source_external_data.absolute(),
        args.output_dir.absolute(),
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
