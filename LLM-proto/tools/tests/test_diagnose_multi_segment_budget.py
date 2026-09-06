from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import diagnose_multi_segment_budget as diagnostic_module  # noqa: E402


class DiagnoseMultiSegmentBudgetTest(unittest.TestCase):
    @staticmethod
    def _costs() -> dict[tuple[int, int], int]:
        return {
            (0, 1): 9,
            (1, 2): 4,
            (2, 3): 8,
            (0, 2): 13,
            (1, 3): 12,
            (0, 3): 20,
        }

    def test_partition_report_explains_infeasible_ceiling(self) -> None:
        report = diagnostic_module._partition_report(
            total_layers=3,
            target_bytes=5,
            tier="preferred",
            limit_bytes=7,
            costs=self._costs(),
        )

        self.assertFalse(report["feasible"])
        self.assertEqual(report["minimumAchievableMaximumBytes"], 9)
        self.assertEqual(
            report["oversizedSingleLayerSpans"],
            [
                {"startLayer": 0, "endLayer": 1, "estimatedBytes": 9},
                {"startLayer": 2, "endLayer": 3, "estimatedBytes": 8},
            ],
        )
        self.assertIn("minimum achievable maximum is 9 bytes", report["error"])

        feasible = diagnostic_module._partition_report(
            total_layers=3,
            target_bytes=5,
            tier="absolute",
            limit_bytes=10,
            costs=self._costs(),
        )
        self.assertTrue(feasible["feasible"])
        self.assertEqual(feasible["cutLayers"], [1, 2])
        self.assertEqual(feasible["maximumEstimatedSegmentBytes"], 9)

    def test_diagnose_model_surfaces_hard_policy_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            source = Path(raw_dir) / "model.onnx"
            source.write_bytes(b"graph")
            hard = diagnostic_module.ABSOLUTE_MAX_BYTES
            costs = {
                (0, 1): hard + 1,
                (1, 2): 20,
                (0, 2): hard + 30,
            }
            initializer_rows = [
                {
                    "name": "model.embed_tokens.weight",
                    "location": "model.onnx_data",
                    "offset": 0,
                    "bytes": hard,
                }
            ]

            with patch.object(diagnostic_module.onnx, "load_model", return_value=object()), patch.object(
                diagnostic_module, "discover_total_layers", return_value=2
            ), patch.object(
                diagnostic_module, "_span_costs", return_value=costs
            ), patch.object(
                diagnostic_module, "_initializer_rows", return_value=initializer_rows
            ), patch.object(
                diagnostic_module, "sha256_file", return_value="a" * 64
            ):
                report = diagnostic_module.diagnose_model(source)

            self.assertEqual(report["status"], "pass")
            self.assertFalse(report["hardPolicyFeasible"])
            self.assertEqual(report["totalLayers"], 2)
            self.assertTrue(all(not item["feasible"] for item in report["partitions"]))
            self.assertEqual(report["worstSingleLayerSpans"][0]["layer"], 0)
            self.assertEqual(
                report["worstSingleLayerSpans"][0]["topExternalInitializers"],
                initializer_rows,
            )
            self.assertEqual(report["sourceModel"]["graphSha256"], "a" * 64)


if __name__ == "__main__":
    unittest.main()
