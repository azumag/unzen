from __future__ import annotations

import tempfile
import sys
import unittest
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from multi_segment_onnx import (  # noqa: E402
    build_segment_spec,
    estimate_segment_bytes,
    prepare_budgeted_multi_split,
)
from verify_multi_segment_kv_decode import (  # noqa: E402
    _present_to_past,
    _run_full_step,
    verify_multi_segment_kv_decode,
)


class VerifyMultiSegmentKvDecodeTest(unittest.TestCase):
    HIDDEN_SIZE = 8
    TOTAL_LAYERS = 4

    def _create_fixture(self, path: Path) -> None:
        hidden = self.HIDDEN_SIZE
        initializers = [
            numpy_helper.from_array(
                np.arange(hidden * hidden, dtype=np.float32).reshape(hidden, hidden)
                / 25.0,
                name="embedding_weight",
            ),
            numpy_helper.from_array(np.asarray([1], dtype=np.int64), name="reduce_seq_axis"),
        ]
        initializers.extend(
            numpy_helper.from_array(
                np.eye(hidden, dtype=np.float32) * (index + 1),
                name=f"weight_{index}",
            )
            for index in range(self.TOTAL_LAYERS)
        )
        initializers.append(
            numpy_helper.from_array(
                np.eye(hidden, dtype=np.float32),
                name="lm_head_weight",
            )
        )

        inputs = [
            helper.make_tensor_value_info(
                "input_ids", TensorProto.INT64, [1, "sequence_length"]
            )
        ]
        for index in range(self.TOTAL_LAYERS):
            for kind in ("key", "value"):
                inputs.append(
                    helper.make_tensor_value_info(
                        f"past_key_values.{index}.{kind}",
                        TensorProto.FLOAT,
                        [1, "past_sequence_length", hidden],
                    )
                )

        nodes = [
            helper.make_node(
                "Gather",
                ["embedding_weight", "input_ids"],
                ["state"],
                name="/model/embed_tokens/Gather",
            )
        ]
        for index in range(self.TOTAL_LAYERS):
            layer_input = "state" if index == 0 else f"state_{index - 1}"
            key_sum = f"past_key_sum_{index}"
            value_sum = f"past_value_sum_{index}"
            cache_sum = f"past_sum_{index}"
            cached_state = f"cached_state_{index}"
            residual = f"residual_{index}"
            mlp = f"mlp_{index}"
            state_output = f"state_{index}"
            nodes.extend(
                [
                    helper.make_node(
                        "ReduceSum",
                        [f"past_key_values.{index}.key", "reduce_seq_axis"],
                        [key_sum],
                        name=f"/model/layers.{index}/attention/past-key-sum",
                        keepdims=1,
                    ),
                    helper.make_node(
                        "ReduceSum",
                        [f"past_key_values.{index}.value", "reduce_seq_axis"],
                        [value_sum],
                        name=f"/model/layers.{index}/attention/past-value-sum",
                        keepdims=1,
                    ),
                    helper.make_node(
                        "Add",
                        [key_sum, value_sum],
                        [cache_sum],
                        name=f"/model/layers.{index}/attention/past-sum",
                    ),
                    helper.make_node(
                        "Add",
                        [layer_input, cache_sum],
                        [cached_state],
                        name=f"/model/layers.{index}/attention/cache-add",
                    ),
                    helper.make_node(
                        "MatMul",
                        [cached_state, f"weight_{index}"],
                        [residual],
                        name=f"/model/layers.{index}/post_attention_layernorm/SkipLayerNorm",
                    ),
                    helper.make_node(
                        "Identity",
                        [cached_state],
                        [mlp],
                        name=f"/model/layers.{index}/mlp/down_proj/MatMul",
                    ),
                    helper.make_node(
                        "Add",
                        [residual, mlp],
                        [state_output],
                        name=f"/model/layers.{index + 1}/input_layernorm/SkipLayerNorm",
                    ),
                    helper.make_node(
                        "Concat",
                        [f"past_key_values.{index}.key", state_output],
                        [f"present.{index}.key"],
                        name=f"fixture-present-key-{index}",
                        axis=1,
                    ),
                    helper.make_node(
                        "Concat",
                        [f"past_key_values.{index}.value", state_output],
                        [f"present.{index}.value"],
                        name=f"fixture-present-value-{index}",
                        axis=1,
                    ),
                ]
            )
        nodes.append(
            helper.make_node(
                "MatMul",
                [f"state_{self.TOTAL_LAYERS - 1}", "lm_head_weight"],
                ["logits"],
                name=f"/model/layers.{self.TOTAL_LAYERS}/lm_head/MatMul",
            )
        )

        outputs = [
            helper.make_tensor_value_info(
                "logits", TensorProto.FLOAT, [1, "sequence_length", hidden]
            )
        ]
        outputs.extend(
            helper.make_tensor_value_info(
                f"present.{index}.{kind}",
                TensorProto.FLOAT,
                [1, "total_sequence_length", hidden],
            )
            for index in range(self.TOTAL_LAYERS)
            for kind in ("key", "value")
        )

        graph = helper.make_graph(
            nodes,
            "fixture-multi-kv-decode",
            inputs,
            outputs,
            initializer=initializers,
        )
        model = helper.make_model(
            graph,
            producer_name="unzen-multi-kv-decode-fixture",
            opset_imports=[helper.make_opsetid("", 18)],
        )
        model.ir_version = 10
        onnx.save_model(model, str(path))

    def _prepare_split(self, root: Path) -> tuple[Path, Path]:
        source = root / "model_q4.onnx"
        self._create_fixture(source)
        model = onnx.load_model(str(source), load_external_data=False)
        full_cost = estimate_segment_bytes(
            model,
            build_segment_spec(
                model,
                0,
                self.TOTAL_LAYERS,
                total_layers=self.TOTAL_LAYERS,
            ),
            hidden_size=self.HIDDEN_SIZE,
        )
        output = root / "split"
        manifest = prepare_budgeted_multi_split(
            source,
            output,
            hidden_size=self.HIDDEN_SIZE,
            target_bytes=max(1, full_cost // 2),
            preferred_max_bytes=full_cost - 1,
            hash_source_external_data=False,
        )
        self.assertGreater(len(manifest["segments"]), 1)
        return source, output / "split-manifest.json"

    def test_prompt_and_cached_decode_match_full_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source, manifest_path = self._prepare_split(Path(tmp))
            report = verify_multi_segment_kv_decode(
                source,
                manifest_path,
                [0, 1],
                2,
                kv_heads=1,
                head_size=self.HIDDEN_SIZE,
            )

            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["decisionStatus"], "diagnostic-only")
            self.assertEqual(report["kvCacheOwnership"], "segment-local")
            self.assertFalse(report["coordinatorRelaysKvCache"])
            self.assertTrue(report["prompt"]["logitsComparison"]["matches"])
            self.assertTrue(report["decode"]["logitsComparison"]["matches"])
            self.assertTrue(report["prompt"]["kvComparison"]["matches"])
            self.assertTrue(report["decode"]["kvComparison"]["matches"])
            self.assertEqual(
                report["decode"]["kvComparison"]["tensorCount"],
                self.TOTAL_LAYERS * 2,
            )
            self.assertGreater(report["decode"]["fullPastCacheBytesConsumed"], 0)
            self.assertGreater(report["decode"]["splitPastCacheBytesConsumed"], 0)
            self.assertGreater(report["prompt"]["boundaryBytes"], 0)
            self.assertGreater(report["decode"]["boundaryBytes"], 0)

    def test_fixture_cached_decode_depends_on_prompt_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model_q4.onnx"
            self._create_fixture(source)
            session = ort.InferenceSession(str(source), providers=["CPUExecutionProvider"])

            _, prompt_present, _ = _run_full_step(
                session,
                token_ids=[0, 1],
                logits_name="logits",
                past_cache=None,
                past_length=0,
                kv_heads=1,
                head_size=self.HIDDEN_SIZE,
            )
            cached_past = {
                _present_to_past(name): value for name, value in prompt_present.items()
            }
            cached_logits, _, consumed = _run_full_step(
                session,
                token_ids=[2],
                logits_name="logits",
                past_cache=cached_past,
                past_length=2,
                kv_heads=1,
                head_size=self.HIDDEN_SIZE,
            )
            cold_logits, _, _ = _run_full_step(
                session,
                token_ids=[2],
                logits_name="logits",
                past_cache=None,
                past_length=0,
                kv_heads=1,
                head_size=self.HIDDEN_SIZE,
            )

            self.assertGreater(consumed, 0)
            self.assertFalse(np.allclose(cached_logits, cold_logits))


if __name__ == "__main__":
    unittest.main()
