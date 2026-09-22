from __future__ import annotations

import sys
from pathlib import Path
import unittest
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import probe_llama_1b_endpoint_embedding_composition_ort_cpu as probe


class EndpointEmbeddingFullCoveragePreflightTest(unittest.TestCase):
    def _execution_tiles(self) -> list[dict[str, object]]:
        tile_rows = probe.VOCAB_ROWS // 8
        bytes_per_row = probe.HIDDEN_SIZE * probe.FLOAT32_BYTES
        return [
            {
                "tileIndex": index,
                "startRow": index * tile_rows,
                "endRowExclusive": (index + 1) * tile_rows,
                "physicalSlices": [
                    {
                        "physicalArtifactIndex": index // 2,
                        "rowCount": tile_rows,
                        "artifactByteOffset": (index % 2) * tile_rows * bytes_per_row,
                        "byteLength": tile_rows * bytes_per_row,
                    }
                ],
            }
            for index in range(8)
        ]

    def _physical_artifacts(self) -> list[dict[str, object]]:
        tile_rows = probe.VOCAB_ROWS // 8
        bytes_per_row = probe.HIDDEN_SIZE * probe.FLOAT32_BYTES
        return [
            {"index": index, "byteLength": 2 * tile_rows * bytes_per_row}
            for index in range(4)
        ]

    def _layout(self, tiles: list[dict[str, object]]) -> dict[str, object]:
        return {
            "kind": probe.layout_probe.REPORT_KIND,
            "schemaVersion": probe.layout_probe.REPORT_SCHEMA_VERSION,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "candidates": [
                {
                    "physicalArtifactCount": 4,
                    "executionTiles": tiles,
                    "physicalArtifacts": self._physical_artifacts(),
                }
            ],
        }

    def test_valid_partition_covers_the_full_vocabulary_in_canonical_order(self) -> None:
        routed = probe._route_probe_tokens(self._execution_tiles())

        self.assertEqual([item[1] for item in routed], list(range(8)))
        self.assertEqual(routed[0][2], 0)
        self.assertEqual(routed[-1][3], probe.VOCAB_ROWS)
        for left, right in zip(routed, routed[1:]):
            self.assertEqual(left[3], right[2])

    def test_unsampled_interior_gap_is_rejected(self) -> None:
        tiles = self._execution_tiles()
        tiles[0]["endRowExclusive"] = 8_000
        tiles[1]["startRow"] = 8_001

        with self.assertRaisesRegex(RuntimeError, "ordered and contiguous"):
            probe._route_probe_tokens(tiles)

    def test_unsampled_interior_overlap_is_rejected(self) -> None:
        tiles = self._execution_tiles()
        tiles[0]["endRowExclusive"] = 8_002
        tiles[1]["startRow"] = 8_001

        with self.assertRaisesRegex(RuntimeError, "ordered and contiguous"):
            probe._route_probe_tokens(tiles)

    def test_prefix_suffix_and_count_drift_are_rejected(self) -> None:
        prefix = self._execution_tiles()
        prefix[0]["startRow"] = 1
        with self.assertRaisesRegex(RuntimeError, "ordered and contiguous"):
            probe._route_probe_tokens(prefix)

        suffix = self._execution_tiles()
        suffix[-1]["endRowExclusive"] = probe.VOCAB_ROWS - 1
        with self.assertRaisesRegex(RuntimeError, "cover the full vocabulary"):
            probe._route_probe_tokens(suffix)

        with self.assertRaisesRegex(RuntimeError, "execution tile count drift"):
            probe._route_probe_tokens(self._execution_tiles()[:-1])

    def test_noncanonical_or_duplicate_tile_indexes_are_rejected(self) -> None:
        for index in (7, 2):
            with self.subTest(index=index):
                tiles = self._execution_tiles()
                tiles[3]["tileIndex"] = index
                with self.assertRaisesRegex(RuntimeError, "canonical list position"):
                    probe._route_probe_tokens(tiles)

    def test_full_coverage_failure_precedes_source_work(self) -> None:
        tiles = self._execution_tiles()
        tiles[0]["endRowExclusive"] = 8_000
        tiles[1]["startRow"] = 8_001

        with (
            mock.patch.object(probe.layout_probe, "build_report", return_value=self._layout(tiles)),
            mock.patch.object(
                probe,
                "_source_embedding_contract",
                side_effect=AssertionError("source work must not run"),
            ) as source_contract,
        ):
            with self.assertRaisesRegex(RuntimeError, "ordered and contiguous"):
                probe.build_report(Path("unused-model.onnx"), Path("unused-payloads"))

        source_contract.assert_not_called()


if __name__ == "__main__":
    unittest.main()
