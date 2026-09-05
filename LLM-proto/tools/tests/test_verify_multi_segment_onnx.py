from __future__ import annotations

import json
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
    build_segment_spec,
    estimate_segment_bytes,
    prepare_budgeted_multi_split,
)
from verify_multi_segment_onnx import (  # noqa: E402
    validate_multi_segment_manifest,
    verify_multi_split,
)


class VerifyMultiSegmentOnnxTest(unittest.TestCase):
    HIDDEN_SIZE = 8
    TOTAL_LAYERS = 4

    def _create_fixture(self, path: Path) -> None:
        hidden = self.HIDDEN_SIZE
        initializers = [
            numpy_helper.from_array(
                np.arange(hidden * hidden, dtype=np.float32).reshape(hidden, hidden)
                / 100.0,
                name="embedding_weight",
            )
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
            residual = f"residual_{index}"
            mlp = f"mlp_{index}"
            state_output = f"state_{index}"
            nodes.extend(
                [
                    helper.make_node(
                        "MatMul",
                        [layer_input, f"weight_{index}"],
                        [residual],
                        name=f"/model/layers.{index}/post_attention_layernorm/SkipLayerNorm",
                    ),
                    helper.make_node(
                        "Identity",
                        [layer_input],
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
                name=f"/model/layers.{self.TOTAL_LAYERS}/lm_head/MatMul",
            )
        )

        graph = helper.make_graph(
            nodes,
            "fixture-multi-verifier",
            [helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, 2])],
            [
                helper.make_tensor_value_info(
                    "logits", TensorProto.FLOAT, [1, 2, hidden]
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
            producer_name="unzen-multi-verifier-fixture",
            opset_imports=[helper.make_opsetid("", 18)],
        )
        model.ir_version = 10
        onnx.save_model(model, str(path))

    def test_generated_multi_split_matches_full_logits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
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

            report = verify_multi_split(
                source,
                output / "split-manifest.json",
                [0, 1],
                kv_heads=1,
                head_size=self.HIDDEN_SIZE,
            )

            self.assertEqual(report["status"], "pass")
            self.assertTrue(report["comparison"]["matches"])
            self.assertEqual(report["fullTop1TokenId"], report["splitTop1TokenId"])
            self.assertEqual(report["segmentCount"], len(manifest["segments"]))
            self.assertEqual(len(report["boundaries"]), len(manifest["segments"]) - 1)
            self.assertGreater(report["boundaryBytes"], 0)

    def test_manifest_validation_rejects_boundary_not_consumed_by_next_segment(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "segment0.onnx").write_bytes(b"fixture")
            (root / "segment1.onnx").write_bytes(b"fixture")
            manifest = {
                "kind": "unzen-budgeted-multi-segment-onnx",
                "artifactLayout": "per-segment-external-data",
                "splitPlan": {"cutLayers": [2]},
                "boundaries": [
                    {
                        "afterLayer": 1,
                        "beforeLayer": 2,
                        "tensors": [{"name": "boundary"}],
                    }
                ],
                "segments": [
                    {
                        "index": 0,
                        "startLayer": 0,
                        "endLayer": 2,
                        "path": "segment0.onnx",
                        "inputs": ["input_ids"],
                        "outputs": ["boundary"],
                    },
                    {
                        "index": 1,
                        "startLayer": 2,
                        "endLayer": 4,
                        "path": "segment1.onnx",
                        "inputs": ["different_boundary"],
                        "outputs": ["logits"],
                    },
                ],
            }

            with self.assertRaisesRegex(ValueError, "tensor contract mismatch"):
                validate_multi_segment_manifest(manifest, root)

    def test_manifest_validation_rejects_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = {
                "kind": "unzen-budgeted-multi-segment-onnx",
                "artifactLayout": "per-segment-external-data",
                "splitPlan": {"cutLayers": []},
                "boundaries": [],
                "segments": [
                    {
                        "index": 0,
                        "startLayer": 0,
                        "endLayer": 4,
                        "path": "../model.onnx",
                        "inputs": ["input_ids"],
                        "outputs": ["logits"],
                    }
                ],
            }

            with self.assertRaisesRegex(ValueError, "unsafe segment path"):
                validate_multi_segment_manifest(manifest, root)


if __name__ == "__main__":
    unittest.main()
