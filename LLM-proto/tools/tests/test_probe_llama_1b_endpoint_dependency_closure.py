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


class ProbeLlama1BEndpointDependencyClosureTest(unittest.TestCase):
    @staticmethod
    def _candidate(physical_count: int) -> dict[str, object]:
        return layout_probe._candidate(
            rows=128_256,
            row_bytes=8_192,
            source_offset_bytes=0,
            physical_count=physical_count,
        )

    @classmethod
    def _fake_layout_report(cls) -> dict[str, object]:
        return {
            "schemaVersion": "1.1.0",
            "kind": layout_probe.REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": "a" * 64,
            "pinnedSourceExternalDataIdentity": {
                "location": "model_q4.onnx_data",
                "bytes": 1_692_672_000,
                "sha256": "b" * 64,
            },
            "candidatePolicy": {
                "physicalArtifactCounts": [4, 5, 8],
                "executionTileCount": 8,
                "preferredPhysicalArtifactLimitBytes": layout_probe.PREFERRED_LIMIT_BYTES,
                "targetBytes": layout_probe.TARGET_BYTES,
            },
            "candidates": [cls._candidate(count) for count in (4, 5, 8)],
        }

    def test_four_way_full_artifact_closure_records_reference_distance(self) -> None:
        closure = closure_probe._candidate_dependency_closure(self._candidate(4))

        self.assertEqual(
            closure["maximumFullArtifactDependencyBytesPerExecutionTile"],
            262_668_288,
        )
        self.assertEqual(
            closure[
                "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"
            ],
            131_334_144,
        )
        self.assertEqual(
            closure["maximumDistanceFromPreferredPhysicalArtifactReferenceBytes"],
            -5_767_168,
        )
        self.assertEqual(
            [item["requiredPhysicalArtifactCount"] for item in closure["tileClosures"]],
            [1] * 8,
        )

    def test_five_way_boundary_crossing_has_larger_full_artifact_closure(self) -> None:
        closure = closure_probe._candidate_dependency_closure(self._candidate(5))

        self.assertEqual(
            closure["maximumFullArtifactDependencyBytesPerExecutionTile"],
            420_274_176,
        )
        self.assertEqual(
            closure[
                "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"
            ],
            288_940_032,
        )
        self.assertEqual(
            closure["maximumDistanceFromPreferredPhysicalArtifactReferenceBytes"],
            151_838_720,
        )

        crossing = closure["tileClosures"][1]
        self.assertEqual(crossing["requiredPhysicalArtifactIndices"], [0, 1])
        self.assertEqual(crossing["executionTileBytes"], 131_334_144)
        self.assertEqual(crossing["fullArtifactDependencyBytes"], 420_274_176)
        self.assertEqual(
            crossing["unusedBytesWithinRequiredFullArtifacts"], 288_940_032
        )
        self.assertEqual(
            crossing["distanceFromPreferredPhysicalArtifactReferenceBytes"],
            151_838_720,
        )

    def test_eight_way_alignment_has_zero_unused_full_artifact_bytes(self) -> None:
        closure = closure_probe._candidate_dependency_closure(self._candidate(8))

        self.assertEqual(
            closure["maximumFullArtifactDependencyBytesPerExecutionTile"],
            131_334_144,
        )
        self.assertEqual(
            closure[
                "maximumUnusedBytesWithinRequiredFullArtifactsPerExecutionTile"
            ],
            0,
        )
        self.assertEqual(
            closure["maximumDistanceFromPreferredPhysicalArtifactReferenceBytes"],
            -137_101_312,
        )
        self.assertTrue(
            all(
                item["fullArtifactDependencyBytes"] == item["executionTileBytes"]
                for item in closure["tileClosures"]
            )
        )

    def test_rejects_unknown_physical_artifact_reference(self) -> None:
        candidate = deepcopy(self._candidate(4))
        candidate["executionTiles"][0]["physicalSlices"][0][
            "physicalArtifactIndex"
        ] = 99

        with self.assertRaisesRegex(RuntimeError, "unknown physical artifact 99"):
            closure_probe._candidate_dependency_closure(candidate)

    def test_rejects_duplicate_physical_artifact_reference_in_one_tile(self) -> None:
        candidate = deepcopy(self._candidate(5))
        crossing_slices = candidate["executionTiles"][1]["physicalSlices"]
        duplicate = deepcopy(crossing_slices[0])
        duplicate["byteLength"] = 1
        crossing_slices.append(duplicate)
        candidate["executionTiles"][1]["byteLength"] += 1

        with self.assertRaisesRegex(RuntimeError, "more than once"):
            closure_probe._candidate_dependency_closure(candidate)

    def test_build_report_preserves_diagnostic_boundary_and_source_identity(self) -> None:
        fake_layout = self._fake_layout_report()

        with patch.object(
            closure_probe.layout_probe, "build_report", return_value=fake_layout
        ):
            report = closure_probe.build_report(Path("model_q4.onnx"))

        self.assertEqual(report["schemaVersion"], "1.0.0")
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["decisionStatus"], "diagnostic-only")
        self.assertEqual(
            report["upstreamProbe"],
            {"kind": layout_probe.REPORT_KIND, "schemaVersion": "1.1.0"},
        )
        self.assertEqual(
            report["pinnedSourceExternalDataIdentity"],
            fake_layout["pinnedSourceExternalDataIdentity"],
        )
        self.assertEqual(
            [
                item["physicalArtifactCount"]
                for item in report["candidateDependencyClosures"]
            ],
            [4, 5, 8],
        )
        self.assertIn("numeric reference", report["conclusion"])
        self.assertIn("dependency-closure calculation only", report["conclusion"])

    def test_build_report_rejects_upstream_schema_drift(self) -> None:
        fake_layout = self._fake_layout_report()
        fake_layout["schemaVersion"] = "2.0.0"

        with patch.object(
            closure_probe.layout_probe, "build_report", return_value=fake_layout
        ):
            with self.assertRaisesRegex(RuntimeError, "schema version"):
                closure_probe.build_report(Path("model_q4.onnx"))

    def test_build_report_rejects_upstream_decision_promotion(self) -> None:
        fake_layout = self._fake_layout_report()
        fake_layout["decisionStatus"] = "approved"

        with patch.object(
            closure_probe.layout_probe, "build_report", return_value=fake_layout
        ):
            with self.assertRaisesRegex(RuntimeError, "must remain diagnostic-only"):
                closure_probe.build_report(Path("model_q4.onnx"))


if __name__ == "__main__":
    unittest.main()
