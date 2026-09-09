#!/usr/bin/env python3
"""Materialize diagnostic 8-physical embedding payload identities for Llama 1B.

This helper advances the pre-decision evidence for #167 / #223 / #320 only.
It reads the already-pinned 8-physical / 8-execution-tile candidate, verifies the
full pinned source graph and external-data identity, and materializes each
131,334,144-byte embedding tile as its own physical payload. The resulting
manifest records exact SHA-256 identities and 1:1 tile-to-payload routing.

It does not select the 8-physical architecture, change the existing 4-physical
browser harness, or claim ORT Web/WebGPU runtime, memory, timing, reclamation,
or numerical-equivalence evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import prepare_llama_1b_endpoint_poststage_tiled_ort_webgpu as poststage_webgpu
import prepare_llama_1b_endpoint_preferred_tile_ort_webgpu as preferred_webgpu
import probe_llama_1b_endpoint_embedding_composition_ort_cpu as embedding_cpu
import probe_llama_1b_endpoint_layout_candidates as layout_probe
import probe_llama_1b_endpoint_preferred_tile_ort_cpu as preferred_cpu


REPORT_KIND = "unzen-pinned-llama-1b-endpoint-embedding-eight-physical-payload-preparation"
REPORT_SCHEMA_VERSION = "1.0.0"
PHYSICAL_ARTIFACT_COUNT = 8
EXECUTION_TILE_COUNT = 8
ROWS_PER_TILE = 16_032
TILE_BYTES = 131_334_144
TOTAL_EMBEDDING_BYTES = 1_050_673_152
SOURCE_GRAPH_BYTES = 149_112
SOURCE_GRAPH_SHA256 = "a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46"
SOURCE_GRAPH_FILE = "model_q4.onnx"
SOURCE_EXTERNAL_FILE = "model_q4.onnx_data"

REMAINING_RUNTIME_EVIDENCE = (
    "ort-webgpu-range-supply",
    "captured-adapter-and-device-limits-for-both-layouts",
    "host-peak-working-set",
    "gpu-peak-working-set",
    "download-cache-read-hash-upload-session-and-first-useful-work-timing",
    "session-release-and-cancel-lag",
    "pinned-reference-numerical-equivalence-for-8-physical",
)


def _require_int(value: object, *, field: str, positive: bool = False) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise RuntimeError(f"{field} must be an integer")
    if positive and value <= 0:
        raise RuntimeError(f"{field} must be positive")
    if not positive and value < 0:
        raise RuntimeError(f"{field} must be non-negative")
    return value


def _validate_candidate(
    layout: dict[str, object],
) -> tuple[int, list[dict[str, object]], list[dict[str, object]]]:
    if (
        layout.get("kind") != layout_probe.REPORT_KIND
        or layout.get("schemaVersion") != layout_probe.REPORT_SCHEMA_VERSION
        or layout.get("status") != "pass"
        or layout.get("decisionStatus") != "diagnostic-only"
    ):
        raise RuntimeError("upstream endpoint layout contract drift")

    source_graph_sha = layout.get("sourceGraphSha256")
    if source_graph_sha != SOURCE_GRAPH_SHA256:
        raise RuntimeError("pinned source graph identity drifted")

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
        raise RuntimeError("expected exactly one pinned 8-physical candidate")

    physical = matches[0].get("physicalArtifacts")
    tiles = matches[0].get("executionTiles")
    if not isinstance(physical, list) or len(physical) != PHYSICAL_ARTIFACT_COUNT:
        raise RuntimeError("8-physical artifact geometry drifted")
    if not isinstance(tiles, list) or len(tiles) != EXECUTION_TILE_COUNT:
        raise RuntimeError("8-way execution tile geometry drifted")
    if not all(isinstance(item, dict) for item in physical + tiles):
        raise RuntimeError("8-way candidate entries must be objects")

    expected_source_offset = 0
    for index, item in enumerate(physical):
        if item.get("index") != index:
            raise RuntimeError("8-physical artifacts must be ordered and indexed 0..7")
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
        if source_offset != expected_source_offset:
            raise RuntimeError(f"physical artifact {index} source range is not contiguous")
        if byte_length != TILE_BYTES or source_end - source_offset != TILE_BYTES:
            raise RuntimeError(f"physical artifact {index} must be exactly one execution tile")
        expected_source_offset = source_end
    if expected_source_offset != TOTAL_EMBEDDING_BYTES:
        raise RuntimeError("8-physical source ranges do not cover the full embedding weight")

    expected_row = 0
    for tile_index, tile in enumerate(tiles):
        if tile.get("tileIndex") != tile_index:
            raise RuntimeError("8-way execution tiles must be ordered and indexed 0..7")
        start_row = _require_int(
            tile.get("startRow"), field=f"tile[{tile_index}].startRow"
        )
        end_row = _require_int(
            tile.get("endRowExclusive"), field=f"tile[{tile_index}].endRowExclusive", positive=True
        )
        row_count = _require_int(
            tile.get("rowCount"), field=f"tile[{tile_index}].rowCount", positive=True
        )
        if start_row != expected_row or row_count != ROWS_PER_TILE:
            raise RuntimeError(f"tile {tile_index} row range drifted")
        if end_row != start_row + ROWS_PER_TILE:
            raise RuntimeError(f"tile {tile_index} end row drifted")

        slices = tile.get("physicalSlices")
        if not isinstance(slices, list) or len(slices) != 1 or not isinstance(slices[0], dict):
            raise RuntimeError(f"tile {tile_index} must map to exactly one physical slice")
        physical_slice = slices[0]
        artifact_index = _require_int(
            physical_slice.get("physicalArtifactIndex"),
            field=f"tile[{tile_index}].physicalArtifactIndex",
        )
        artifact_offset = _require_int(
            physical_slice.get("artifactByteOffset"),
            field=f"tile[{tile_index}].artifactByteOffset",
        )
        byte_length = _require_int(
            physical_slice.get("byteLength"),
            field=f"tile[{tile_index}].byteLength",
            positive=True,
        )
        if artifact_index != tile_index or artifact_offset != 0 or byte_length != TILE_BYTES:
            raise RuntimeError(f"tile {tile_index} must map 1:1 to physical artifact {tile_index}")
        expected_row = end_row
    if expected_row != embedding_cpu.VOCAB_ROWS:
        raise RuntimeError("8-way execution tiles do not cover the full vocabulary")

    return hidden_size, physical, tiles


def _payload_set_sha256(artifacts: list[dict[str, object]]) -> str:
    encoded = json.dumps(artifacts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def prepare(source_model: Path, source_external_data: Path, output_dir: Path) -> dict[str, object]:
    source_model = source_model.resolve()
    source_external_data = source_external_data.resolve()
    if source_model.name != SOURCE_GRAPH_FILE:
        raise RuntimeError(f"pinned source graph file must be {SOURCE_GRAPH_FILE}")
    if source_external_data.name != SOURCE_EXTERNAL_FILE:
        raise RuntimeError(f"pinned source external-data file must be {SOURCE_EXTERNAL_FILE}")
    if source_model.stat().st_size != SOURCE_GRAPH_BYTES:
        raise RuntimeError("pinned source graph byte length drifted")

    layout = layout_probe.build_report(source_model)
    hidden_size, physical, tiles = _validate_candidate(layout)
    inferred_source, source_weight_offset, source_weight_length = embedding_cpu._source_embedding_contract(
        source_model, layout
    )
    if inferred_source != source_external_data:
        raise RuntimeError("explicit source external-data path does not match source graph location")
    if source_weight_offset != 0 or source_weight_length != TOTAL_EMBEDDING_BYTES:
        raise RuntimeError("pinned embedding source range drifted")

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

        manifest_artifacts: list[dict[str, object]] = []
        for index, item in enumerate(physical):
            source_offset = _require_int(
                item.get("sourceOffsetBytes"), field=f"physical[{index}].sourceOffsetBytes"
            )
            source_end = _require_int(
                item.get("sourceEndOffsetBytesExclusive"),
                field=f"physical[{index}].sourceEndOffsetBytesExclusive",
                positive=True,
            )
            payload_path = output_dir / f"payload-{index:04d}.bin"
            digest = poststage_webgpu._copy_fd_range(
                source_fd,
                source_offset=source_offset,
                length=TILE_BYTES,
                destination=payload_path,
            )
            created.append(payload_path)
            manifest_artifacts.append(
                {
                    "index": index,
                    "file": payload_path.name,
                    "bytes": TILE_BYTES,
                    "sha256": digest,
                    "sourceOffsetBytes": source_offset,
                    "sourceEndOffsetBytesExclusive": source_end,
                }
            )

        if source_path_identity is None:
            raise RuntimeError("source external-data identity was not pinned")
        preferred_cpu._assert_payload_path_identity(
            source_external_data, pinned_identity=source_path_identity
        )

        manifest_tiles: list[dict[str, object]] = []
        for tile_index, tile in enumerate(tiles):
            start_row = _require_int(tile.get("startRow"), field=f"tile[{tile_index}].startRow")
            end_row = _require_int(
                tile.get("endRowExclusive"), field=f"tile[{tile_index}].endRowExclusive", positive=True
            )
            manifest_tiles.append(
                {
                    "tileIndex": tile_index,
                    "startRow": start_row,
                    "endRowExclusive": end_row,
                    "rowCount": ROWS_PER_TILE,
                    "physicalArtifactIndex": tile_index,
                    "artifactByteOffset": 0,
                    "byteLength": TILE_BYTES,
                }
            )

        manifest = {
            "schemaVersion": REPORT_SCHEMA_VERSION,
            "kind": REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "selectedPhysicalArtifactCount": None,
            "candidatePhysicalArtifactCount": PHYSICAL_ARTIFACT_COUNT,
            "executionTileCount": EXECUTION_TILE_COUNT,
            "sourceGraphSha256": SOURCE_GRAPH_SHA256,
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
            "physicalArtifacts": manifest_artifacts,
            "payloadSetSha256": _payload_set_sha256(manifest_artifacts),
            "tiles": manifest_tiles,
            "coverage": {
                "sourceOffsetBytes": 0,
                "sourceEndOffsetBytesExclusive": TOTAL_EMBEDDING_BYTES,
                "bytes": TOTAL_EMBEDDING_BYTES,
                "contiguous": True,
                "tileToPhysicalArtifactOneToOne": True,
            },
            "remainingRuntimeEvidence": list(REMAINING_RUNTIME_EVIDENCE),
            "conclusion": (
                "Materialized and SHA-256 identified the diagnostic 8-physical / 8-tile embedding "
                "payload candidate directly from the pinned source external-data. This removes only "
                "the generated-payload-identity blocker; it does not select the layout or establish "
                "browser/WebGPU range supply, memory, timing, reclamation, or numerical equivalence."
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
