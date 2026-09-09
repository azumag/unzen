from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_llama_1b_endpoint_embedding_eight_physical_payloads as prep
import probe_llama_1b_endpoint_layout_candidates as layout_probe


class EndpointEmbeddingEightPhysicalPayloadPreparationTest(unittest.TestCase):
    def _layout_report(self) -> dict[str, object]:
        physical = []
        tiles = []
        for index in range(prep.PHYSICAL_ARTIFACT_COUNT):
            source_offset = index * prep.TILE_BYTES
            source_end = source_offset + prep.TILE_BYTES
            physical.append(
                {
                    "index": index,
                    "startRow": index * prep.ROWS_PER_TILE,
                    "endRowExclusive": (index + 1) * prep.ROWS_PER_TILE,
                    "rowCount": prep.ROWS_PER_TILE,
                    "sourceOffsetBytes": source_offset,
                    "sourceEndOffsetBytesExclusive": source_end,
                    "byteLength": prep.TILE_BYTES,
                }
            )
            tiles.append(
                {
                    "tileIndex": index,
                    "startRow": index * prep.ROWS_PER_TILE,
                    "endRowExclusive": (index + 1) * prep.ROWS_PER_TILE,
                    "rowCount": prep.ROWS_PER_TILE,
                    "physicalSlices": [
                        {
                            "physicalArtifactIndex": index,
                            "artifactByteOffset": 0,
                            "byteLength": prep.TILE_BYTES,
                        }
                    ],
                }
            )
        return {
            "kind": layout_probe.REPORT_KIND,
            "schemaVersion": layout_probe.REPORT_SCHEMA_VERSION,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": prep.SOURCE_GRAPH_SHA256,
            "rowBytes": 2048 * 4,
            "pinnedSourceExternalDataIdentity": {
                "location": prep.SOURCE_EXTERNAL_FILE,
                "bytes": prep.preferred_webgpu.PINNED_EXTERNAL_DATA_BYTES,
                "sha256": prep.preferred_webgpu.PINNED_EXTERNAL_DATA_SHA256,
            },
            "candidates": [
                {
                    "physicalArtifactCount": prep.PHYSICAL_ARTIFACT_COUNT,
                    "executionTileCount": prep.EXECUTION_TILE_COUNT,
                    "physicalArtifacts": physical,
                    "executionTiles": tiles,
                }
            ],
        }

    def test_candidate_validation_pins_eight_payloads_one_to_one_with_tiles(self) -> None:
        layout = self._layout_report()
        hidden_size, physical, tiles = prep._validate_candidate(layout)

        self.assertEqual(hidden_size, 2048)
        self.assertEqual(len(physical), 8)
        self.assertEqual(len(tiles), 8)
        self.assertEqual(physical[-1]["sourceEndOffsetBytesExclusive"], prep.TOTAL_EMBEDDING_BYTES)
        for index, tile in enumerate(tiles):
            self.assertEqual(tile["physicalSlices"][0]["physicalArtifactIndex"], index)
            self.assertEqual(tile["physicalSlices"][0]["artifactByteOffset"], 0)

    def test_candidate_validation_rejects_nonzero_artifact_offset(self) -> None:
        layout = self._layout_report()
        layout["candidates"][0]["executionTiles"][3]["physicalSlices"][0]["artifactByteOffset"] = 1

        with self.assertRaisesRegex(RuntimeError, "must map 1:1"):
            prep._validate_candidate(layout)

    def test_candidate_validation_rejects_source_range_gap(self) -> None:
        layout = self._layout_report()
        layout["candidates"][0]["physicalArtifacts"][4]["sourceOffsetBytes"] += 1

        with self.assertRaisesRegex(RuntimeError, "source range is not contiguous"):
            prep._validate_candidate(layout)

    def test_prepare_records_generated_payload_identity_without_selecting_layout(self) -> None:
        layout = self._layout_report()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_model = root / prep.SOURCE_GRAPH_FILE
            source_model.write_bytes(b"\0" * prep.SOURCE_GRAPH_BYTES)
            source_external = root / prep.SOURCE_EXTERNAL_FILE
            source_external.write_bytes(b"source-placeholder")
            output_dir = root / "out"

            fake_fd = os.open(source_external, os.O_RDONLY)
            fake_identity = (1, 2, 3, 4, 5)

            def fake_copy(
                source_fd: int,
                *,
                source_offset: int,
                length: int,
                destination: Path,
                expected_sha256: str | None = None,
            ) -> str:
                self.assertEqual(source_fd, fake_fd)
                self.assertEqual(length, prep.TILE_BYTES)
                self.assertIsNone(expected_sha256)
                destination.write_bytes(bytes([source_offset // prep.TILE_BYTES]))
                return f"{source_offset // prep.TILE_BYTES:064x}"

            with (
                mock.patch.object(prep.layout_probe, "build_report", return_value=layout),
                mock.patch.object(
                    prep.embedding_cpu,
                    "_source_embedding_contract",
                    return_value=(source_external.resolve(), 0, prep.TOTAL_EMBEDDING_BYTES),
                ),
                mock.patch.object(
                    prep.preferred_cpu,
                    "_open_pinned_payload",
                    return_value=(
                        fake_fd,
                        {
                            "byteLength": prep.preferred_webgpu.PINNED_EXTERNAL_DATA_BYTES,
                            "sha256": prep.preferred_webgpu.PINNED_EXTERNAL_DATA_SHA256,
                        },
                        fake_identity,
                    ),
                ),
                mock.patch.object(prep.preferred_cpu, "_assert_payload_path_identity"),
                mock.patch.object(prep.poststage_webgpu, "_copy_fd_range", side_effect=fake_copy),
                mock.patch.object(prep.os, "close") as close_mock,
            ):
                manifest = prep.prepare(source_model, source_external, output_dir)

            close_mock.assert_called_once_with(fake_fd)
            os.close(fake_fd)

            self.assertEqual(manifest["decisionStatus"], "diagnostic-only")
            self.assertIsNone(manifest["selectedPhysicalArtifactCount"])
            self.assertEqual(manifest["candidatePhysicalArtifactCount"], 8)
            self.assertEqual(len(manifest["physicalArtifacts"]), 8)
            self.assertEqual(len(manifest["tiles"]), 8)
            self.assertEqual(manifest["coverage"]["bytes"], prep.TOTAL_EMBEDDING_BYTES)
            self.assertTrue(manifest["coverage"]["contiguous"])
            self.assertTrue(manifest["coverage"]["tileToPhysicalArtifactOneToOne"])
            self.assertNotIn("generated-8-physical-payload-identity", manifest["remainingRuntimeEvidence"])
            self.assertTrue((output_dir / "manifest.json").is_file())
            for index, artifact in enumerate(manifest["physicalArtifacts"]):
                self.assertEqual(artifact["index"], index)
                self.assertEqual(artifact["bytes"], prep.TILE_BYTES)
                self.assertEqual(artifact["sha256"], f"{index:064x}")
                self.assertEqual((output_dir / artifact["file"]).read_bytes(), bytes([index]))

    def test_payload_set_digest_is_order_sensitive_and_deterministic(self) -> None:
        artifacts = [
            {"index": 0, "sha256": "0" * 64},
            {"index": 1, "sha256": "1" * 64},
        ]
        first = prep._payload_set_sha256(artifacts)
        second = prep._payload_set_sha256(list(artifacts))
        reversed_digest = prep._payload_set_sha256(list(reversed(artifacts)))
        self.assertEqual(first, second)
        self.assertNotEqual(first, reversed_digest)


if __name__ == "__main__":
    unittest.main()
