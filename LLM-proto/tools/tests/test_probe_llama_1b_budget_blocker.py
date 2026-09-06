from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import probe_llama_1b_budget_blocker as probe_module  # noqa: E402


class ProbeLlama1BBudgetBlockerTest(unittest.TestCase):
    @staticmethod
    def _report() -> dict[str, object]:
        initializer = {
            "name": probe_module.EXPECTED_ENDPOINT_INITIALIZER,
            "bytes": probe_module.EXPECTED_ENDPOINT_INITIALIZER_BYTES,
        }
        return {
            "sourceModel": {"graphSha256": probe_module.EXPECTED_GRAPH_SHA256},
            "totalLayers": probe_module.EXPECTED_TOTAL_LAYERS,
            "hardPolicyFeasible": False,
            "partitions": [
                {
                    "tier": tier,
                    "feasible": False,
                    "minimumAchievableMaximumBytes": probe_module.EXPECTED_MINIMUM_MAX_BYTES,
                    "oversizedSingleLayerSpans": probe_module.EXPECTED_OVERSIZED_SINGLETONS,
                }
                for tier in probe_module.EXPECTED_TIERS
            ],
            "worstSingleLayerSpans": [
                {"layer": 15, "topExternalInitializers": [initializer]},
                {"layer": 0, "topExternalInitializers": [initializer]},
            ],
            "endpointIsolationCandidates": {
                "available": True,
                "decisionStatus": "diagnostic-only",
                "stages": [
                    {
                        "stageKind": stage_kind,
                        "estimatedArtifactBytes": estimated_bytes,
                        "estimatedTierFeasibility": probe_module.EXPECTED_ENDPOINT_STAGE_TIERS,
                        "estimatedTierMarginBytes": (
                            probe_module.EXPECTED_ENDPOINT_STAGE_MARGINS[stage_kind]
                        ),
                        "smallestPassingTier": "absolute",
                        "topExternalInitializers": [initializer],
                    }
                    for stage_kind, estimated_bytes in (
                        probe_module.EXPECTED_ENDPOINT_STAGE_ARTIFACTS.items()
                    )
                ],
            },
        }

    def test_accepts_pinned_blocker_shape(self) -> None:
        result = probe_module.validate_report(self._report())
        self.assertEqual(result["status"], "pass")
        self.assertEqual(
            result["minimumAchievableMaximumBytes"],
            probe_module.EXPECTED_MINIMUM_MAX_BYTES,
        )

    def test_rejects_budget_floor_drift(self) -> None:
        report = self._report()
        report["partitions"][2]["minimumAchievableMaximumBytes"] -= 1
        with self.assertRaisesRegex(RuntimeError, "absolute minimum achievable maximum"):
            probe_module.validate_report(report)

    def test_rejects_endpoint_isolation_budget_drift(self) -> None:
        report = self._report()
        report["endpointIsolationCandidates"]["stages"][0]["estimatedTierFeasibility"] = {
            "preferred": False,
            "normal": False,
            "absolute": False,
        }
        with self.assertRaisesRegex(RuntimeError, "embedding-prefix policy tiers"):
            probe_module.validate_report(report)


if __name__ == "__main__":
    unittest.main()
