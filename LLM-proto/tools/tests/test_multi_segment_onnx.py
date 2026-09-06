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
    _external_initializer_bytes,
    _select_partition,
    _validate_budget_options,
    build_segment_spec,
    build_segment_specs,
    discover_total_layers,
    estimate_segment_bytes,
    plan_layer_spans,
    prepare_budgeted_multi_split,
)
from prepare_browser_p0 import PREFERRED_MAX_BYTES  # noqa: E402


class BudgetedMultiSegmentTest(unittest.TestCase):
    HIDDEN_SIZE = 16
    TOTAL_LAYERS = 4

    def _create_fixture(
        self,
        path: Path,
        *,
        external_location: str = "weights.bin",
    ) -> None:
        """Create a genuinely chained Llama-shaped graph with external weights."""

        hidden = self.HIDDEN_SIZE
        initializers = [
            numpy_helper.from_array(
                np.arange(hidden * hidden, dtype=np.float32).reshape(hidden, hidden)
                / 100.0,
                name="embedding_weight",
            ),
        ]
        for index in range(self.TOTAL_LAYERS):
            initializers.append(
                numpy_helper.from_array(
                    np.eye(hidden, dtype=np.float32) * (index + 1),
                    name=f"weight_{index}",
                )
            )
        initializers.append(
            numpy_helper.from_array(
                np.eye(hidden, dtype=np.float32),
                name="lm_head_weight",
            )
        )

        nodes = [
            helper.make_node(
                "Gather",
                ["embedding_weight", "input_ids"],
                ["state"],
                name="/model/embed_tokens/Gather",
            ),
        ]
        for index in range(self.TOTAL_LAYERS):
            layer_input = "state" if index == 0 else f"state_{index - 1}"
            residual = f"residual_{index}"
            mlp = f"mlp_{index}"
            state_output = f"state_{index}"
            nodes.extend(
                [
                    helper.make_node(
                        "MatMul",
                        [layer_input, f"weight_{index}"],
                        [residual],
                        name=(
                            f"/model/layers.{index}/"
                            "post_attention_layernorm/SkipLayerNorm"
                        ),
                    ),
                    helper.make_node(
                        "Identity",
                        [layer_input],
                        [mlp],
                        name=f"/model/layers.{index}/mlp/down_proj/MatMul",
                    ),
                    # The next layer's input norm consumes the two real boundary
                    # tensors. This is the exact pattern discover_boundary()
                    # intentionally fails closed around.
                    helper.make_node(
                        "Add",
                        [residual, mlp],
                        [state_output],
                        name=(
                            f"/model/layers.{index + 1}/"
                            "input_layernorm/SkipLayerNorm"
                        ),
                    ),
                    helper.make_node(
                        "Identity",
                        [state_output],
                        [f"present.{index}.key"],
                        name=f"fixture-present-key-{index}",
                    ),
                    helper.make_node(
                        "Identity",
                        [state_output],
                        [f"present.{index}.value"],
                        name=f"fixture-present-value-{index}",
                    ),
                ]
            )
        nodes.append(
            helper.make_node(
                "MatMul",
                [f"state_{self.TOTAL_LAYERS - 1}", "lm_head_weight"],
                ["logits"],
                name=(
                    f"/model/layers.{self.TOTAL_LAYERS}/"
                    "lm_head/MatMul"
                ),
            )
        )

        graph = helper.make_graph(
            nodes,
            "fixture-budgeted-graph",
            [
                helper.make_tensor_value_info(
                    "input_ids",
                    TensorProto.INT64,
                    [1, 2],
                )
            ],
            [
                helper.make_tensor_value_info(
                    "logits",
                    TensorProto.FLOAT,
                    [1, 2, hidden],
                ),
                *[
                    helper.make_tensor_value_info(
                        f"present.{index}.{kind}",
                        TensorProto.FLOAT,
                        [1, 2, hidden],
                    )
                    for index in range(self.TOTAL_LAYERS)
                    for kind in ("key", "value")
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
            location=external_location,
            size_threshold=0,
        )

    def _load_fixture(
        self,
        root: Path,
        *,
        external_location: str = "weights.bin",
    ) -> tuple[Path, onnx.ModelProto]:
        source = root / "model_q4.onnx"
        self._create_fixture(source, external_location=external_location)
        return source, onnx.load_model(str(source), load_external_data=False)

    def _full_cost(self, model: onnx.ModelProto) -> int:
        return estimate_segment_bytes(
            model,
            build_segment_spec(
                model,
                0,
                self.TOTAL_LAYERS,
                total_layers=self.TOTAL_LAYERS,
            ),
            hidden_size=self.HIDDEN_SIZE,
        )

    def test_polynomial_partitioner_scales_to_sixty_layers(self) -> None:
        calls = 0

        def span_cost(start: int, end: int) -> int:
            nonlocal calls
            calls += 1
            return end - start

        cuts, costs = _select_partition(
            total_layers=60,
            target_bytes=4,
            required_max_bytes=4,
            span_cost=span_cost,
        )

        self.assertEqual(cuts, tuple(range(4, 60, 4)))
        self.assertEqual(costs, (4,) * 15)
        # Every contiguous span is costed once; no cut-combination enumeration.
        self.assertEqual(calls, 60 * 61 // 2)

    def test_planner_and_generator_use_the_same_graph_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            _, model = self._load_fixture(Path(tmp))
            self.assertEqual(discover_total_layers(model), self.TOTAL_LAYERS)

            full_cost = self._full_cost(model)
            cuts, costs = plan_layer_spans(
                model,
                hidden_size=self.HIDDEN_SIZE,
                target_bytes=max(1, full_cost // 2),
                required_max_bytes=full_cost - 1,
            )
            self.assertTrue(cuts)

            specs = build_segment_specs(model, cuts)
            generated_contract_costs = tuple(
                estimate_segment_bytes(
                    model,
                    spec,
                    hidden_size=self.HIDDEN_SIZE,
                )
                for spec in specs
            )
            self.assertEqual(costs, generated_contract_costs)

            for spec in specs:
                for layer in range(spec.start_layer, spec.end_layer):
                    self.assertIn(f"present.{layer}.key", spec.output_names)
                    self.assertIn(f"present.{layer}.value", spec.output_names)
            self.assertIn("logits", specs[-1].output_names)

    def test_external_byte_estimate_deduplicates_aliased_ranges(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            _, model = self._load_fixture(Path(tmp))
            by_name = {initializer.name: initializer for initializer in model.graph.initializer}
            first = by_name["weight_0"]
            second = by_name["weight_1"]
            second_metadata = {
                entry.key: entry.value for entry in second.external_data
            }
            second_length = int(second_metadata["length"])
            before = _external_initializer_bytes(model)

            del second.external_data[:]
            for source_entry in first.external_data:
                copied = second.external_data.add()
                copied.CopyFrom(source_entry)
            second.data_location = TensorProto.EXTERNAL

            self.assertEqual(
                _external_initializer_bytes(model),
                before - second_length,
            )

    def test_external_byte_estimate_rejects_unsafe_location(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            _, model = self._load_fixture(Path(tmp))
            initializer = model.graph.initializer[0]
            for entry in initializer.external_data:
                if entry.key == "location":
                    entry.value = "../escape.bin"
                    break
            with self.assertRaisesRegex(ValueError, "unsafe external-data location"):
                _external_initializer_bytes(model)

    def test_fails_closed_when_no_partition_meets_budget(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            _, model = self._load_fixture(Path(tmp))
            with self.assertRaisesRegex(
                RuntimeError,
                r"no contiguous partition.*minimum achievable maximum is \d+ bytes.*"
                r"single-layer spans over budget",
            ):
                plan_layer_spans(
                    model,
                    hidden_size=self.HIDDEN_SIZE,
                    target_bytes=1,
                    required_max_bytes=1,
                )

    def test_partition_failure_reports_exact_budget_floor(self) -> None:
        costs = {
            (0, 1): 4,
            (1, 2): 9,
            (2, 3): 4,
            (0, 2): 15,
            (1, 3): 15,
            (0, 3): 20,
        }

        with self.assertRaisesRegex(
            RuntimeError,
            r"minimum achievable maximum is 9 bytes; "
            r"single-layer spans over budget: \[1,2\)=9",
        ):
            _select_partition(
                total_layers=3,
                target_bytes=5,
                required_max_bytes=5,
                span_cost=lambda start, end: costs[(start, end)],
            )

    def test_generates_and_repacks_independent_shards(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, model = self._load_fixture(root)
            full_cost = self._full_cost(model)
            budget = full_cost - 1
            target = max(1, full_cost // 2)
            expected_cuts, _ = plan_layer_spans(
                model,
                hidden_size=self.HIDDEN_SIZE,
                target_bytes=target,
                required_max_bytes=budget,
            )

            output = root / "split"
            manifest = prepare_budgeted_multi_split(
                source,
                output,
                hidden_size=self.HIDDEN_SIZE,
                target_bytes=target,
                preferred_max_bytes=budget,
            )

            self.assertEqual(
                manifest["kind"],
                "unzen-budgeted-multi-segment-onnx",
            )
            self.assertEqual(
                manifest["splitPlan"]["cutLayers"],
                list(expected_cuts),
            )
            self.assertEqual(
                manifest["splitPlan"]["targetBytes"],
                target,
            )
            self.assertEqual(
                manifest["splitPlan"]["requiredMaxBytes"],
                budget,
            )
            self.assertGreater(len(manifest["segments"]), 1)
            self.assertFalse((output / "weights.bin").exists())

            generated_maximum = 0
            for segment in manifest["segments"]:
                generated_maximum = max(
                    generated_maximum,
                    segment["browserArtifactBytes"],
                )
                self.assertLessEqual(segment["browserArtifactBytes"], budget)
                self.assertTrue(segment["externalData"])
                index = segment["index"]
                self.assertTrue((output / f"segment{index}.onnx").is_file())
                self.assertTrue(
                    (output / f"segment{index}.onnx_data").is_file()
                )
            self.assertEqual(
                manifest["splitPlan"]["maximumGeneratedSegmentBytes"],
                generated_maximum,
            )

    def test_rejects_generated_path_that_would_overwrite_source_data(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, _ = self._load_fixture(
                root,
                external_location="segment0.onnx_data",
            )
            with self.assertRaisesRegex(ValueError, "overwrite source data"):
                prepare_budgeted_multi_split(
                    source,
                    root,
                    hidden_size=self.HIDDEN_SIZE,
                    target_bytes=1,
                    preferred_max_bytes=PREFERRED_MAX_BYTES,
                    hash_source_external_data=False,
                )

    def test_budget_options_cannot_relax_product_policy(self) -> None:
        with self.assertRaisesRegex(ValueError, "cannot relax"):
            _validate_budget_options(
                hidden_size=self.HIDDEN_SIZE,
                target_bytes=1,
                preferred_max_bytes=PREFERRED_MAX_BYTES + 1,
            )
        with self.assertRaisesRegex(ValueError, "cannot exceed"):
            _validate_budget_options(
                hidden_size=self.HIDDEN_SIZE,
                target_bytes=2,
                preferred_max_bytes=1,
            )

    def test_cut_layers_must_be_strictly_increasing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            _, model = self._load_fixture(Path(tmp))
            with self.assertRaisesRegex(ValueError, "strictly increasing"):
                build_segment_specs(model, (2, 2))


if __name__ == "__main__":
    unittest.main()
