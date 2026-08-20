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

from split_llama_1b_onnx import split_model  # noqa: E402
from verify_split_onnx import verify_split  # noqa: E402


def create_fixture_model(path: Path) -> None:
    input_ids = helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, 2])
    logits = helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, 2, 3])
    present0 = helper.make_tensor_value_info("present.0.key", TensorProto.FLOAT, [1, 2, 4])
    present8 = helper.make_tensor_value_info("present.8.key", TensorProto.FLOAT, [1, 2, 4])

    embedding = numpy_helper.from_array(
        np.arange(64, dtype=np.float32).reshape(16, 4) / 10.0,
        name="embedding_weight",
    )
    w0 = numpy_helper.from_array(np.eye(4, dtype=np.float32), name="layer7_weight")
    w1 = numpy_helper.from_array(
        np.asarray(
            [
                [1.0, 0.0, -1.0],
                [0.5, 0.5, 0.5],
                [0.0, 1.0, 0.0],
                [-0.5, 0.0, 1.0],
            ],
            dtype=np.float32,
        ),
        name="lm_head_weight",
    )

    nodes = [
        helper.make_node(
            "Gather",
            ["embedding_weight", "input_ids"],
            ["embedded"],
            name="/model/embed_tokens/Gather",
            axis=0,
        ),
        helper.make_node(
            "MatMul",
            ["embedded", "layer7_weight"],
            ["layer7_residual"],
            name="/model/layers.7/post_attention_layernorm/SkipLayerNorm",
        ),
        helper.make_node(
            "Identity",
            ["embedded"],
            ["layer7_mlp"],
            name="/model/layers.7/mlp/down_proj/MatMul",
        ),
        helper.make_node(
            "Identity",
            ["layer7_residual"],
            ["present.0.key"],
            name="fixture-present-0",
        ),
        helper.make_node(
            "Add",
            ["layer7_residual", "layer7_mlp"],
            ["layer8_hidden"],
            name="/model/layers.8/input_layernorm/SkipLayerNorm",
        ),
        helper.make_node(
            "Identity",
            ["layer8_hidden"],
            ["present.8.key"],
            name="fixture-present-8",
        ),
        helper.make_node(
            "MatMul",
            ["layer8_hidden", "lm_head_weight"],
            ["logits"],
            name="/model/layers.16/lm_head/MatMul",
        ),
    ]

    value_info = [
        helper.make_tensor_value_info("embedded", TensorProto.FLOAT, [1, 2, 4]),
        helper.make_tensor_value_info("layer7_residual", TensorProto.FLOAT, [1, 2, 4]),
        helper.make_tensor_value_info("layer7_mlp", TensorProto.FLOAT, [1, 2, 4]),
        helper.make_tensor_value_info("layer8_hidden", TensorProto.FLOAT, [1, 2, 4]),
    ]
    graph = helper.make_graph(
        nodes,
        "fixture-llama-like-graph",
        [input_ids],
        [logits, present0, present8],
        initializer=[embedding, w0, w1],
        value_info=value_info,
    )
    model = helper.make_model(
        graph,
        producer_name="unzen-fixture",
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


class SplitLlamaOnnxTest(unittest.TestCase):
    def test_preserves_external_data_and_matches_full_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model_q4.onnx"
            create_fixture_model(source)
            output = root / "split"

            manifest = split_model(
                source,
                output,
                split_layer=8,
                hidden_size=4,
                external_data_mode="symlink",
            )

            self.assertEqual(manifest["kind"], "unzen-real-two-segment-onnx")
            self.assertEqual(manifest["boundary"]["tensorCount"], 2)
            self.assertEqual(manifest["boundary"]["bytesPerToken"], 32)
            boundary_names = [item["name"] for item in manifest["boundary"]["tensors"]]
            self.assertEqual(boundary_names, ["layer7_residual", "layer7_mlp"])
            self.assertTrue((output / "weights.bin").is_symlink())

            segment0 = onnx.load_model(str(output / "segment0.onnx"), load_external_data=False)
            segment1 = onnx.load_model(str(output / "segment1.onnx"), load_external_data=False)
            self.assertEqual([value.name for value in segment0.graph.input], ["input_ids"])
            self.assertEqual([value.name for value in segment1.graph.input], boundary_names)
            self.assertIn("present.0.key", [value.name for value in segment0.graph.output])
            self.assertIn("present.8.key", [value.name for value in segment1.graph.output])
            self.assertIn("logits", [value.name for value in segment1.graph.output])

            external_locations = {
                entry.value
                for model in (segment0, segment1)
                for initializer in model.graph.initializer
                for entry in initializer.external_data
                if entry.key == "location"
            }
            self.assertEqual(external_locations, {"weights.bin"})

            report = verify_split(
                source,
                output / "segment0.onnx",
                output / "segment1.onnx",
                output / "split-manifest.json",
                [1, 2],
                provider="CPUExecutionProvider",
                kv_heads=8,
                head_size=64,
                atol=0,
                rtol=0,
            )
            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["fullTop1TokenId"], report["splitTop1TokenId"])
            self.assertEqual(report["comparison"]["maxAbsDiff"], 0.0)

            parsed_manifest = json.loads((output / "split-manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(parsed_manifest["segments"][0]["sha256"], manifest["segments"][0]["sha256"])
            self.assertEqual(parsed_manifest["segments"][1]["sha256"], manifest["segments"][1]["sha256"])

    def test_boundary_detection_fails_closed_when_layer8_contract_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model_q4.onnx"
            create_fixture_model(source)
            model = onnx.load_model(str(source), load_external_data=False)
            target = next(node for node in model.graph.node if "layers.8/input_layernorm" in node.name)
            target.input[:] = ["layer7_residual"]
            broken = root / "broken.onnx"
            onnx.save_model(model, str(broken))
            with self.assertRaisesRegex(ValueError, "exactly two layer-boundary tensors"):
                split_model(broken, root / "out", hidden_size=4, external_data_mode="none")


if __name__ == "__main__":
    unittest.main()
