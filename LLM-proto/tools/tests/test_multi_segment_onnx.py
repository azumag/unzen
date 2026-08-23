from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from multi_segment_onnx import (  # noqa: E402
    build_segment_specs,
    discover_total_layers,
    plan_layer_spans,
    prepare_budgeted_multi_split,
)


class BudgetedMultiSegmentTest(unittest.TestCase):
    def _create_fixture(self, path: Path) -> None:
        hidden = 4
        initializers = [
            numpy_helper.from_array(
                np.arange(16, dtype=np.float32).reshape(4, 4) / 10.0,
                name="embedding_weight",
            ),
        ]
        for index in range(4):
            initializers.append(numpy_helper.from_array(
                np.eye(hidden, dtype=np.float32) * (index + 1),
                name=f"weight_{index}",
            ))
        initializers.append(numpy_helper.from_array(
            np.eye(hidden, dtype=np.float32),
            name="lm_head_weight",
        ))

        nodes = [
            helper.make_node(
                "Gather",
                ["embedding_weight", "input_ids"],
                ["state"],
                name="/model/embed_tokens/Gather",
            ),
        ]
        for index in range(4):
            residual = f"residual_{index}"
            mlp = f"mlp_{index}"
            nodes.extend([
                helper.make_node(
                    "MatMul",
                    ["state", f"weight_{index}"],
                    [residual],
                    name=f"/model/layers.{index}/post_attention_layernorm/SkipLayerNorm",
                ),
                helper.make_node(
                    "Identity",
                    ["state"],
                    [mlp],
                    name=f"/model/layers.{index}/mlp/down_proj/MatMul",
                ),
                helper.make_node(
                    "Add",
                    [residual, mlp],
                    [f"state_{index}"],
                    name=f"/model/layers.{index + 1}/input_layernorm/SkipLayerNorm",
                ),
                helper.make_node(
                    "Identity",
                    [f"state_{index}"],
                    [f"present.{index}.key"],
                    name=f"fixture-present-{index}",
                ),
            ])
        nodes.append(helper.make_node(
            "MatMul",
            ["state_3", "lm_head_weight"],
            ["logits"],
            name="/model/layers.4/lm_head/MatMul",
        ))

        graph = helper.make_graph(
            nodes,
            "fixture-budgeted-graph",
            [helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, 2])],
            [
                helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, 2, 4]),
                *[
                    helper.make_tensor_value_info(
                        f"present.{index}.key", TensorProto.FLOAT, [1, 2, 4]
                    )
                    for index in range(4)
                ],
            ],
            initializer=initializers,
        )
        model = helper.make_model(
            graph,
            producer_name="unzen-budget-fixture",
            opset_imports=[helper.make_opsetid("", 18)],
        )
        model.ir_version = 10
        onnx.save_model(
            model,
            str(path),
            save_as_external_data=True,
            all_tensors_to_one_file=True,
            location="weights.bin",
            size_threshold=0,
        )

    def test_plans_minimum_balanced_contiguous_spans(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model_q4.onnx"
            self._create_fixture(source)
            model = onnx.load_model(str(source), load_external_data=False)
            self.assertEqual(discover_total_layers(model), 4)

            cuts, costs = plan_layer_spans(
                model,
                hidden_size=4,
                target_bytes=1400,
                required_max_bytes=2000,
            )
            self.assertEqual(cuts, (3,))
            self.assertEqual(len(costs), 2)
            self.assertLessEqual(max(costs), 1700)

    def test_fails_closed_when_no_partition_meets_budget(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model_q4.onnx"
            self._create_fixture(source)
            model = onnx.load_model(str(source), load_external_data=False)
            with self.assertRaisesRegex(RuntimeError, "no contiguous partition"):
                plan_layer_spans(
                    model,
                    hidden_size=4,
                    target_bytes=64,
                    required_max_bytes=80,
                )

    def test_generates_and_repacks_independent_shards(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model_q4.onnx"
            self._create_fixture(source)
            output = root / "split"
            manifest = prepare_budgeted_multi_split(
                source,
                output,
                hidden_size=4,
                target_bytes=1400,
                preferred_max_bytes=2000,
            )

            self.assertEqual(manifest["kind"], "unzen-budgeted-multi-segment-onnx")
            self.assertEqual(manifest["splitPlan"]["cutLayers"], [3])
            self.assertEqual(len(manifest["segments"]), 2)
            self.assertTrue((output / "segment0.onnx_data").is_file())
            self.assertTrue((output / "segment1.onnx_data").is_file())
            self.assertFalse((output / "weights.bin").exists())
            for segment in manifest["segments"]:
                self.assertLessEqual(segment["browserArtifactBytes"], 2000)
                self.assertTrue(segment["externalData"])

            specs = build_segment_specs(
                onnx.load_model(str(source), load_external_data=False),
                (2,),
            )
            self.assertEqual([spec.start_layer for spec in specs], [0, 2])
            self.assertEqual([spec.end_layer for spec in specs], [2, 4])


if __name__ == "__main__":
    unittest.main()
