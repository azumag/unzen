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
    @staticmethod
    def _source_identity() -> dict[str, object]:
        return {
            "location": "model_q4.onnx_data",
            "bytes": 1_692_672_000,
            "sha256": "b" * 64,
        }

    @classmethod
    def _fake_envelope(cls) -> dict[str, object]:
        return {
            "kind": "unzen-pinned-llama-1b-endpoint-chunk-envelope-probe",
            "schemaVersion": "1.2.0",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": "a" * 64,
            "pinnedSourceExternalDataIdentity": cls._source_identity(),
            "endpointChunkEnvelope": {
                stage: {
                    "rows": 128_256,
                    "rowBytes": 8_192,
                    "sourceOffsetBytes": 0,
                    "sourceLocation": "model_q4.onnx_data",
                    "tiers": {
                        "preferred": {
                            "limitBytes": probe_module.PREFERRED_LIMIT_BYTES,
                        }
                    },
                }
                for stage in ("embedding-prefix", "logits-postfix")
            },
        }

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
        self.assertEqual(candidate["totalPhysicalSlicesAcrossExecutionTiles"], 12)
        self.assertTrue(candidate["executionTileSourceRangesCoverWeightExactly"])
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

        crossing_tile = candidate["executionTiles"][1]
        self.assertEqual(crossing_tile["sourceOffsetBytes"], 131_334_144)
        self.assertEqual(
            crossing_tile["sourceEndOffsetBytesExclusive"], 262_668_288
        )
        self.assertEqual(
            crossing_tile["physicalSlices"],
            [
                {
                    "physicalArtifactIndex": 0,
                    "startRow": 16_032,
                    "endRowExclusive": 25_652,
                    "rowCount": 9_620,
                    "artifactByteOffset": 131_334_144,
                    "artifactByteEndOffsetExclusive": 210_141_184,
                    "sourceOffsetBytes": 131_334_144,
                    "sourceEndOffsetBytesExclusive": 210_141_184,
                    "byteLength": 78_807_040,
                },
                {
                    "physicalArtifactIndex": 1,
                    "startRow": 25_652,
                    "endRowExclusive": 32_064,
                    "rowCount": 6_412,
                    "artifactByteOffset": 0,
                    "artifactByteEndOffsetExclusive": 52_527_104,
                    "sourceOffsetBytes": 210_141_184,
                    "sourceEndOffsetBytesExclusive": 262_668_288,
                    "byteLength": 52_527_104,
                },
            ],
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
        self.assertEqual(four["totalPhysicalSlicesAcrossExecutionTiles"], 8)
        self.assertTrue(four["executionTileSourceRangesCoverWeightExactly"])
        self.assertTrue(four["executionTilesContainedWithinSinglePhysicalArtifact"])
        self.assertFalse(
            four["allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries"]
        )

        self.assertEqual(eight["maximumPhysicalArtifactBytes"], 131_334_144)
        self.assertEqual(eight["totalPhysicalSlicesAcrossExecutionTiles"], 8)
        self.assertTrue(eight["executionTileSourceRangesCoverWeightExactly"])
        self.assertTrue(eight["executionTilesContainedWithinSinglePhysicalArtifact"])
        self.assertTrue(
            eight["allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries"]
        )

    def test_tile_bindings_reject_physical_source_offset_drift(self) -> None:
        physical = probe_module._balanced_ranges(
            rows=128_256,
            row_bytes=8_192,
            count=4,
            source_offset_bytes=0,
        )
        tiles = probe_module._balanced_ranges(
            rows=128_256,
            row_bytes=8_192,
            count=8,
            source_offset_bytes=0,
        )
        physical[1]["sourceOffsetBytes"] += 8_192

        with self.assertRaisesRegex(RuntimeError, "source-byte-contiguous"):
            probe_module._tile_bindings(physical, tiles, row_bytes=8_192)

    def test_build_report_requires_tied_embedding_and_logits_geometry_to_match(self) -> None:
        fake_envelope = self._fake_envelope()
        fake_envelope["endpointChunkEnvelope"]["logits-postfix"]["rows"] = 128_255

        with patch.object(
            probe_module.envelope_probe, "probe_graph", return_value=fake_envelope
        ):
            with self.assertRaisesRegex(RuntimeError, "tied-weight geometry diverged"):
                probe_module.build_report(Path("model_q4.onnx"))

    def test_build_report_requires_pinned_external_data_identity(self) -> None:
        fake_envelope = self._fake_envelope()
        del fake_envelope["pinnedSourceExternalDataIdentity"]

        with patch.object(
            probe_module.envelope_probe, "probe_graph", return_value=fake_envelope
        ):
            with self.assertRaisesRegex(
                RuntimeError, "pinnedSourceExternalDataIdentity must be an object"
            ):
                probe_module.build_report(Path("model_q4.onnx"))

    def test_build_report_rejects_external_data_location_drift(self) -> None:
        fake_envelope = self._fake_envelope()
        fake_envelope["pinnedSourceExternalDataIdentity"]["location"] = "other.bin"

        with patch.object(
            probe_module.envelope_probe, "probe_graph", return_value=fake_envelope
        ):
            with self.assertRaisesRegex(RuntimeError, "identity location diverged"):
                probe_module.build_report(Path("model_q4.onnx"))

    def test_build_report_rejects_preferred_policy_drift(self) -> None:
        fake_envelope = self._fake_envelope()
        for stage in ("embedding-prefix", "logits-postfix"):
            fake_envelope["endpointChunkEnvelope"][stage]["tiers"]["preferred"][
                "limitBytes"
            ] += 1

        with patch.object(
            probe_module.envelope_probe, "probe_graph", return_value=fake_envelope
        ):
            with self.assertRaisesRegex(RuntimeError, "preferred payload limit drifted"):
                probe_module.build_report(Path("model_q4.onnx"))

    def test_build_report_keeps_candidate_comparison_diagnostic_only(self) -> None:
        fake_envelope = self._fake_envelope()

        with patch.object(
            probe_module.envelope_probe, "probe_graph", return_value=fake_envelope
        ):
            report = probe_module.build_report(Path("model_q4.onnx"))

        self.assertEqual(report["schemaVersion"], "1.1.0")
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["decisionStatus"], "diagnostic-only")
        self.assertEqual(
            report["upstreamProbe"],
            {
                "kind": "unzen-pinned-llama-1b-endpoint-chunk-envelope-probe",
                "schemaVersion": "1.2.0",
            },
        )
        self.assertEqual(
            report["pinnedSourceExternalDataIdentity"], self._source_identity()
        )
        self.assertEqual(
            report["candidatePolicy"]["preferredPhysicalArtifactLimitBytes"],
            probe_module.PREFERRED_LIMIT_BYTES,
        )
        self.assertEqual(report["weightBytes"], 1_050_673_152)
        self.assertEqual(
            [candidate["physicalArtifactCount"] for candidate in report["candidates"]],
            [4, 5, 8],
        )
        self.assertIn("exact source-byte", report["conclusion"])
        self.assertIn(
            "do not establish ORT/WebGPU feasibility", report["conclusion"]
        )


if __name__ == "__main__":
    unittest.main()
