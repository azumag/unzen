from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import probe_llama_1b_endpoint_dependency_closure as closure_probe  # noqa: E402
import probe_llama_1b_endpoint_layout_candidates as layout_probe  # noqa: E402
import probe_llama_1b_endpoint_p0_layout_comparison as p0_probe  # noqa: E402


class ProbeLlama1BEndpointP0LayoutComparisonTest(unittest.TestCase):
    @staticmethod
    def _candidate(physical_count: int) -> dict[str, object]:
        return layout_probe._candidate(
            rows=128_256,
            row_bytes=8_192,
            source_offset_bytes=0,
            physical_count=physical_count,
        )

    @classmethod
    def _fake_reports(cls) -> tuple[dict[str, object], dict[str, object]]:
        candidates = [cls._candidate(count) for count in (4, 5, 8)]
        identity = {
            "location": "model_q4.onnx_data",
            "bytes": 1_692_672_000,
            "sha256": "b" * 64,
        }
        policy = {
            "physicalArtifactCounts": [4, 5, 8],
            "executionTileCount": 8,
            "preferredPhysicalArtifactLimitBytes": layout_probe.PREFERRED_LIMIT_BYTES,
            "targetBytes": layout_probe.TARGET_BYTES,
        }
        layout = {
            "schemaVersion": layout_probe.REPORT_SCHEMA_VERSION,
            "kind": layout_probe.REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": "a" * 64,
            "pinnedSourceExternalDataIdentity": identity,
            "candidatePolicy": policy,
            "candidates": candidates,
        }
        closure = {
            "schemaVersion": closure_probe.REPORT_SCHEMA_VERSION,
            "kind": closure_probe.REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": "a" * 64,
            "pinnedSourceExternalDataIdentity": deepcopy(identity),
            "candidatePolicy": deepcopy(policy),
            "candidateDependencyClosures": [
                closure_probe._candidate_dependency_closure(candidate)
                for candidate in candidates
            ],
        }
        return layout, closure

    def _build(self) -> dict[str, object]:
        layout, closure = self._fake_reports()
        with patch.object(p0_probe.layout_probe, "build_report", return_value=layout):
            with patch.object(
                p0_probe.closure_probe, "build_report", return_value=closure
            ):
                return p0_probe.build_report(Path("model_q4.onnx"))

    def test_pins_exact_four_vs_eight_comparison_without_selecting_a_layout(self) -> None:
        report = self._build()

        self.assertEqual(report["schemaVersion"], "1.0.0")
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["decisionStatus"], "diagnostic-only")
        self.assertIsNone(report["selectedPhysicalArtifactCount"])
        self.assertEqual(
            report["comparisonScope"],
            {"physicalArtifactCounts": [4, 8], "executionTileCount": 8},
        )

        four = report["candidates"]["4-physical-8-tile"]
        eight = report["candidates"]["8-physical-8-tile"]
        self.assertEqual(four["maximumPhysicalArtifactBytes"], 262_668_288)
        self.assertEqual(eight["maximumPhysicalArtifactBytes"], 131_334_144)
        self.assertEqual(four["maximumExecutionTileBytes"], 131_334_144)
        self.assertEqual(eight["maximumExecutionTileBytes"], 131_334_144)
        self.assertEqual(
            four["maximumFullArtifactDependencyBytesPerExecutionTile"],
            262_668_288,
        )
        self.assertEqual(
            eight["maximumFullArtifactDependencyBytesPerExecutionTile"],
            131_334_144,
        )
        self.assertEqual(
            four[
                "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"
            ],
            131_334_144,
        )
        self.assertEqual(
            eight[
                "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"
            ],
            0,
        )
        self.assertFalse(
            four["allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries"]
        )
        self.assertTrue(
            eight["allExecutionTileBoundariesAlignToPhysicalArtifactBoundaries"]
        )

        self.assertEqual(
            report["deltasEightMinusFour"],
            {
                "physicalArtifactCount": 4,
                "maximumPhysicalArtifactBytes": -131_334_144,
                "maximumExecutionTileBytes": 0,
                "maximumFullArtifactDependencyBytesPerExecutionTile": -131_334_144,
                "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile": -131_334_144,
                "totalPhysicalSlicesAcrossExecutionTiles": 0,
            },
        )
        self.assertTrue(report["remainingEvidence"])
        self.assertTrue(
            all(
                item["status"] == "not-measured-by-this-probe"
                and item["requiredBeforeArchitectureSelection"] is True
                for item in report["remainingEvidence"]
            )
        )

    def test_rejects_layout_decision_promotion(self) -> None:
        layout, closure = self._fake_reports()
        layout["decisionStatus"] = "approved"

        with patch.object(p0_probe.layout_probe, "build_report", return_value=layout):
            with patch.object(
                p0_probe.closure_probe, "build_report", return_value=closure
            ):
                with self.assertRaisesRegex(RuntimeError, "must remain diagnostic-only"):
                    p0_probe.build_report(Path("model_q4.onnx"))

    def test_rejects_source_identity_drift_between_upstreams(self) -> None:
        layout, closure = self._fake_reports()
        closure["sourceGraphSha256"] = "c" * 64

        with patch.object(p0_probe.layout_probe, "build_report", return_value=layout):
            with patch.object(
                p0_probe.closure_probe, "build_report", return_value=closure
            ):
                with self.assertRaisesRegex(RuntimeError, "source graph identity mismatch"):
                    p0_probe.build_report(Path("model_q4.onnx"))

    def test_rejects_missing_eight_physical_candidate(self) -> None:
        layout, closure = self._fake_reports()
        layout["candidates"] = [
            item
            for item in layout["candidates"]
            if item["physicalArtifactCount"] != 8
        ]

        with patch.object(p0_probe.layout_probe, "build_report", return_value=layout):
            with patch.object(
                p0_probe.closure_probe, "build_report", return_value=closure
            ):
                with self.assertRaisesRegex(RuntimeError, "comparison candidates missing"):
                    p0_probe.build_report(Path("model_q4.onnx"))

    def test_rejects_execution_tile_byte_drift_even_when_both_upstreams_agree(self) -> None:
        layout, closure = self._fake_reports()
        eight = next(
            item
            for item in layout["candidates"]
            if item["physicalArtifactCount"] == 8
        )
        eight["maximumExecutionTileBytes"] += 8_192

        with patch.object(p0_probe.layout_probe, "build_report", return_value=layout):
            with patch.object(
                p0_probe.closure_probe, "build_report", return_value=closure
            ):
                with self.assertRaisesRegex(RuntimeError, "execution tile bytes drifted"):
                    p0_probe.build_report(Path("model_q4.onnx"))

    def test_rejects_eight_way_nonzero_unused_whole_artifact_bytes(self) -> None:
        layout, closure = self._fake_reports()
        eight = next(
            item
            for item in closure["candidateDependencyClosures"]
            if item["physicalArtifactCount"] == 8
        )
        eight[
            "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"
        ] = 1

        with patch.object(p0_probe.layout_probe, "build_report", return_value=layout):
            with patch.object(
                p0_probe.closure_probe, "build_report", return_value=closure
            ):
                with self.assertRaisesRegex(RuntimeError, "must remain 1:1"):
                    p0_probe.build_report(Path("model_q4.onnx"))


if __name__ == "__main__":
    unittest.main()
