from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import probe_llama_1b_endpoint_layout_candidates as probe_module  # noqa: E402


class ProbeLlama1BEndpointLayoutCandidatesTest(unittest.TestCase):
    def test_balanced_five_way_layout_is_target_sized_and_exact(self) -> None:
        ranges = probe_module._balanced_ranges(
            rows=128_256,
            row_bytes=8_192,
            count=5,
            source_offset_bytes=0,
        )

        self.assertEqual(
            [item["rowCount"] for item in ranges],
            [25_652, 25_651, 25_651, 25_651, 25_651],
        )
        self.assertEqual(ranges[0]["byteLength"], 210_141_184)
        self.assertEqual(
            ranges[-1]["sourceEndOffsetBytesExclusive"], 1_050_673_152
        )
        self.assertEqual(sum(item["byteLength"] for item in ranges), 1_050_673_152)

    def test_five_physical_artifacts_make_some_eight_way_tiles_cross_boundaries(self) -> None:
        candidate = probe_module._candidate(
            rows=128_256,
            row_bytes=8_192,
            source_offset_bytes=0,
            physical_count=5,
        )

        self.assertEqual(candidate["maximumPhysicalArtifactBytes"], 210_141_184)
        self.assertEqual(candidate["maximumExecutionTileBytes"], 131_334_144)
        self.assertTrue(candidate["physicalArtifactsFitPreferredPayloadLimit"])
        self.assertEqual(
            candidate["maximumPhysicalArtifactDistanceFromTargetBytes"], 425_984
        )
        self.assertEqual(candidate["maximumPhysicalArtifactsPerExecutionTile"], 2)
        self.assertFalse(
            candidate["executionTilesContainedWithinSinglePhysicalArtifact"]
        )
        self.assertFalse(
            candidate["allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries"]
        )
        self.assertEqual(
            [item["physicalArtifactCount"] for item in candidate["executionTiles"]],
            [1, 2, 1, 2, 2, 1, 2, 1],
        )

    def test_four_and_eight_way_layouts_have_distinct_binding_geometry(self) -> None:
        four = probe_module._candidate(
            rows=128_256,
            row_bytes=8_192,
            source_offset_bytes=0,
            physical_count=4,
        )
        eight = probe_module._candidate(
            rows=128_256,
            row_bytes=8_192,
            source_offset_bytes=0,
            physical_count=8,
        )

        self.assertEqual(four["maximumPhysicalArtifactBytes"], 262_668_288)
        self.assertTrue(four["executionTilesContainedWithinSinglePhysicalArtifact"])
        self.assertFalse(
            four["allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries"]
        )

        self.assertEqual(eight["maximumPhysicalArtifactBytes"], 131_334_144)
        self.assertTrue(eight["executionTilesContainedWithinSinglePhysicalArtifact"])
        self.assertTrue(
            eight["allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries"]
        )

    def test_build_report_requires_tied_embedding_and_logits_geometry_to_match(self) -> None:
        fake_envelope = {
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": "a" * 64,
            "endpointChunkEnvelope": {
                "embedding-prefix": {
                    "rows": 128_256,
                    "rowBytes": 8_192,
                    "sourceOffsetBytes": 0,
                    "sourceLocation": "model_q4.onnx_data",
                },
                "logits-postfix": {
                    "rows": 128_255,
                    "rowBytes": 8_192,
                    "sourceOffsetBytes": 0,
                    "sourceLocation": "model_q4.onnx_data",
                },
            },
        }

        with patch.object(
            probe_module.envelope_probe, "probe_graph", return_value=fake_envelope
        ):
            with self.assertRaisesRegex(RuntimeError, "tied-weight geometry diverged"):
                probe_module.build_report(Path("model_q4.onnx"))

    def test_build_report_keeps_candidate_comparison_diagnostic_only(self) -> None:
        fake_envelope = {
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": "a" * 64,
            "endpointChunkEnvelope": {
                stage: {
                    "rows": 128_256,
                    "rowBytes": 8_192,
                    "sourceOffsetBytes": 0,
                    "sourceLocation": "model_q4.onnx_data",
                }
                for stage in ("embedding-prefix", "logits-postfix")
            },
        }

        with patch.object(
            probe_module.envelope_probe, "probe_graph", return_value=fake_envelope
        ):
            report = probe_module.build_report(Path("model_q4.onnx"))

        self.assertEqual(report["schemaVersion"], "1.0.0")
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["decisionStatus"], "diagnostic-only")
        self.assertEqual(report["weightBytes"], 1_050_673_152)
        self.assertEqual(
            [candidate["physicalArtifactCount"] for candidate in report["candidates"]],
            [4, 5, 8],
        )
        self.assertIn(
            "does not establish ORT/WebGPU feasibility", report["conclusion"]
        )


if __name__ == "__main__":
    unittest.main()
