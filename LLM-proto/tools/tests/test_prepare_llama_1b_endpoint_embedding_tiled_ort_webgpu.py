from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_llama_1b_endpoint_embedding_tiled_ort_webgpu as prep
import probe_llama_1b_endpoint_layout_candidates as layout_probe


class EndpointEmbeddingTiledWebGpuPreparationTest(unittest.TestCase):
    def test_embedding_graph_variants_reuse_pinned_zero_and_nonzero_offset_models(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            variants = prep._write_graph_variants(Path(tmp), hidden_size=2048)
        self.assertEqual(variants, prep.EXPECTED_GRAPH_VARIANTS)
        self.assertEqual(variants["offset0"]["bytes"], 260)
        self.assertEqual(variants["offsetHalf"]["bytes"], 268)

    def test_candidate_validation_requires_exact_four_artifacts_and_eight_tiles(self) -> None:
        physical = [
            {"index": index, "byteLength": prep.PHYSICAL_BYTES}
            for index in range(prep.PHYSICAL_ARTIFACT_COUNT)
        ]
        tiles = [
            {"tileIndex": index, "rowCount": prep.ROWS_PER_TILE}
            for index in range(prep.EXECUTION_TILE_COUNT)
        ]
        layout = {
            "kind": layout_probe.REPORT_KIND,
            "schemaVersion": layout_probe.REPORT_SCHEMA_VERSION,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "rowBytes": 2048 * 4,
            "candidates": [
                {
                    "physicalArtifactCount": prep.PHYSICAL_ARTIFACT_COUNT,
                    "physicalArtifacts": physical,
                    "executionTiles": tiles,
                }
            ],
        }
        hidden_size, actual_physical, actual_tiles = prep._validate_candidate(layout)
        self.assertEqual(hidden_size, 2048)
        self.assertEqual(actual_physical, physical)
        self.assertEqual(actual_tiles, tiles)

    def test_report_contract_remains_diagnostic_only(self) -> None:
        self.assertEqual(
            prep.REPORT_KIND,
            "unzen-pinned-llama-1b-endpoint-embedding-tiled-ort-webgpu-preparation",
        )
        self.assertEqual(
            prep.RUNTIME_REPORT_KIND,
            "unzen-pinned-llama-1b-endpoint-embedding-tiled-ort-webgpu-runtime",
        )
        self.assertEqual(prep.ORT_WEB_VERSION, "1.22.0")
        self.assertEqual(prep.PHYSICAL_ARTIFACT_COUNT, 4)
        self.assertEqual(prep.EXECUTION_TILE_COUNT, 8)


if __name__ == "__main__":
    unittest.main()
