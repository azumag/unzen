from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import onnx
from onnx import TensorProto, helper


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

    @staticmethod
    def _external_initializer(name: str, length: int) -> TensorProto:
        tensor = TensorProto()
        tensor.name = name
        tensor.data_type = TensorProto.FLOAT
        tensor.dims.extend([1])
        tensor.data_location = TensorProto.EXTERNAL
        tensor.external_data.add(key="location", value="model.onnx_data")
        tensor.external_data.add(key="offset", value="0")
        tensor.external_data.add(key="length", value=str(length))
        return tensor

    @classmethod
    def _endpoint_fixture(cls) -> onnx.ModelProto:
        input_ids = helper.make_tensor_value_info(
            "input_ids", TensorProto.INT64, [1, 1]
        )
        last_a = helper.make_tensor_value_info(
            "last_a", TensorProto.FLOAT, [1, 1, 4]
        )
        last_b = helper.make_tensor_value_info(
            "last_b", TensorProto.FLOAT, [1, 1, 4]
        )
        logits = helper.make_tensor_value_info(
            "logits", TensorProto.FLOAT, [1, 1, 4]
        )
        embed = cls._external_initializer("model.embed_tokens.weight", 100)
        final_weight = cls._external_initializer(
            "model.layers.2.final_norm_layernorm.weight", 8
        )
        layer0_weight = helper.make_tensor(
            "model.layers.0.input_layernorm.weight", TensorProto.FLOAT, [1], [1.0]
        )
        nodes = [
            helper.make_node(
                "Gather",
                ["model.embed_tokens.weight", "input_ids"],
                ["embed_out"],
                name="/model/embed_tokens/Gather",
            ),
            helper.make_node(
                "Add",
                ["embed_out", "model.layers.0.input_layernorm.weight"],
                ["layer0_norm"],
                name="/model/layers.0/input_layernorm/LayerNorm",
            ),
            helper.make_node(
                "Identity", ["last_a"], ["boundary_a"], name="/model/layers.1/a"
            ),
            helper.make_node(
                "Identity", ["last_b"], ["boundary_b"], name="/model/layers.1/b"
            ),
            helper.make_node(
                "Add",
                [
                    "boundary_a",
                    "boundary_b",
                    "model.layers.2.final_norm_layernorm.weight",
                ],
                ["final_norm"],
                name="/model/layers.2/final_norm_layernorm/SkipLayerNorm",
            ),
            helper.make_node(
                "Transpose",
                ["model.embed_tokens.weight"],
                ["lm_head_weight"],
                name="/lm_head/Transpose",
            ),
            helper.make_node(
                "MatMul",
                ["final_norm", "lm_head_weight"],
                ["logits"],
                name="/lm_head/MatMul",
            ),
        ]
        graph = helper.make_graph(
            nodes,
            "endpoint-fixture",
            [input_ids, last_a, last_b],
            [logits],
            initializer=[embed, final_weight, layer0_weight],
        )
        return helper.make_model(graph)

    def test_endpoint_isolation_candidates_measure_edge_only_contracts(self) -> None:
        report = diagnostic_module._endpoint_isolation_report(
            self._endpoint_fixture(),
            total_layers=2,
            hidden_size=4,
            top_initializers=4,
        )

        self.assertTrue(report["available"])
        self.assertEqual(report["decisionStatus"], "diagnostic-only")
        stages = {item["stageKind"]: item for item in report["stages"]}
        prefix = stages["embedding-prefix"]
        postfix = stages["logits-postfix"]
        self.assertEqual(prefix["externalDataBytes"], 100)
        self.assertEqual(postfix["externalDataBytes"], 108)
        self.assertEqual(prefix["externalDataLayout"]["uniqueRangeCount"], 1)
        self.assertEqual(prefix["externalDataLayout"]["uniqueLocationCount"], 1)
        self.assertEqual(prefix["externalDataLayout"]["largestRangeBytes"], 100)
        self.assertEqual(
            prefix["externalDataLayout"]["largestRange"]["initializerNames"],
            ["model.embed_tokens.weight"],
        )
        self.assertTrue(
            prefix["externalDataLayout"]["existingRangeTierFeasibility"]["preferred"]
        )
        self.assertEqual(postfix["externalDataLayout"]["uniqueRangeCount"], 2)
        self.assertEqual(postfix["externalDataLayout"]["uniqueExternalBytes"], 108)
        self.assertTrue(prefix["estimatedTierFeasibility"]["preferred"])
        self.assertTrue(postfix["estimatedTierFeasibility"]["absolute"])
        self.assertEqual(prefix["smallestPassingTier"], "preferred")
        self.assertGreater(prefix["estimatedTierMarginBytes"]["preferred"], 0)
        self.assertEqual(postfix["smallestPassingTier"], "preferred")
        self.assertGreater(postfix["estimatedTierMarginBytes"]["absolute"], 0)
        self.assertEqual(
            prefix["topExternalInitializers"][0]["name"],
            "model.embed_tokens.weight",
        )
        self.assertEqual(
            postfix["extraInputNames"],
            ["boundary_a", "boundary_b"],
        )

    def test_external_data_layout_deduplicates_aliased_ranges(self) -> None:
        segment = helper.make_model(
            helper.make_graph(
                [],
                "aliased-ranges",
                [],
                [],
                initializer=[
                    self._external_initializer("weight.a", 100),
                    self._external_initializer("weight.b", 100),
                ],
            )
        )

        layout = diagnostic_module._external_data_layout(segment)

        self.assertEqual(layout["uniqueRangeCount"], 1)
        self.assertEqual(layout["uniqueExternalBytes"], 100)
        self.assertEqual(
            layout["largestRange"]["initializerNames"],
            ["weight.a", "weight.b"],
        )

    def test_first_axis_payload_chunk_lower_bound_quantifies_vocab_split_floor(self) -> None:
        tensor = self._external_initializer("model.embed_tokens.weight", 1_050_673_152)
        del tensor.dims[:]
        tensor.dims.extend([128_256, 2048])
        segment = helper.make_model(
            helper.make_graph([], "chunk-floor", [], [], initializer=[tensor])
        )

        floor = diagnostic_module._external_data_layout(segment)[
            "firstAxisPayloadChunkLowerBound"
        ]
        self.assertTrue(floor["available"])
        self.assertEqual(floor["decisionStatus"], "diagnostic-only")
        self.assertEqual(floor["shape"], [128_256, 2048])
        self.assertEqual(floor["rowBytes"], 8192)
        preferred = floor["tierPayloadLowerBounds"]["preferred"]
        normal = floor["tierPayloadLowerBounds"]["normal"]
        absolute = floor["tierPayloadLowerBounds"]["absolute"]
        self.assertEqual(preferred["minimumPayloadCount"], 4)
        self.assertEqual(preferred["balancedMaximumRows"], 32_064)
        self.assertEqual(preferred["balancedMaximumPayloadBytes"], 262_668_288)
        self.assertEqual(preferred["balancedPayloadHeadroomBytes"], 5_767_168)
        self.assertEqual(normal["minimumPayloadCount"], 2)
        self.assertEqual(normal["balancedMaximumPayloadBytes"], 525_336_576)
        self.assertEqual(absolute["minimumPayloadCount"], 1)
        self.assertEqual(absolute["balancedMaximumPayloadBytes"], 1_050_673_152)
        self.assertIn("payload-only lower bound", floor["note"])

    def test_first_axis_payload_chunk_lower_bound_rejects_shape_alias_ambiguity(self) -> None:
        first = self._external_initializer("weight.a", 100)
        del first.dims[:]
        first.dims.extend([10, 10])
        second = self._external_initializer("weight.b", 100)
        del second.dims[:]
        second.dims.extend([20, 5])
        segment = helper.make_model(
            helper.make_graph([], "ambiguous-alias", [], [], initializer=[first, second])
        )

        floor = diagnostic_module._external_data_layout(segment)[
            "firstAxisPayloadChunkLowerBound"
        ]
        self.assertFalse(floor["available"])
        self.assertEqual(floor["reason"], "aliased-initializer-shapes-differ")

    def test_stage_budget_report_surfaces_no_passing_tier(self) -> None:
        segment = helper.make_model(
            helper.make_graph(
                [],
                "oversized-stage",
                [],
                [],
                initializer=[
                    self._external_initializer(
                        "oversized.weight",
                        diagnostic_module.ABSOLUTE_MAX_BYTES + 1,
                    )
                ],
            )
        )
        report = diagnostic_module._stage_budget_report(
            segment,
            stage_kind="oversized",
            output_names=(),
            extra_input_names=(),
            top_initializers=1,
        )

        self.assertIsNone(report["smallestPassingTier"])
        self.assertFalse(report["estimatedTierFeasibility"]["absolute"])
        self.assertLess(report["estimatedTierMarginBytes"]["absolute"], 0)
        self.assertFalse(
            report["externalDataLayout"]["existingRangeTierFeasibility"]["absolute"]
        )
        self.assertEqual(
            report["externalDataLayout"]["largestRangeBytes"],
            diagnostic_module.ABSOLUTE_MAX_BYTES + 1,
        )

    def test_endpoint_isolation_unavailable_is_nonfatal(self) -> None:
        model = helper.make_model(helper.make_graph([], "empty", [], []))
        report = diagnostic_module._endpoint_isolation_report(
            model, total_layers=2, hidden_size=4, top_initializers=4
        )
        self.assertFalse(report["available"])
        self.assertIn("input_layernorm", report["error"])

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
            ), patch.object(
                diagnostic_module,
                "_endpoint_isolation_report",
                return_value={"available": False, "decisionStatus": "diagnostic-only"},
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
