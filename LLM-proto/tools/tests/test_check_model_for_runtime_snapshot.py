from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import onnx
from onnx import TensorProto, helper

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import split_llama_1b_onnx as target  # noqa: E402


def _model_bytes(*, custom_runtime_op: bool = False) -> bytes:
    x = helper.make_tensor_value_info("x", TensorProto.FLOAT, [1])
    y = helper.make_tensor_value_info("y", TensorProto.FLOAT, [1])
    op_type = "SimplifiedLayerNormalization" if custom_runtime_op else "Identity"
    node = helper.make_node(op_type, ["x"], ["y"], name="fixture")
    graph = helper.make_graph([node], "runtime-checker-fixture", [x], [y])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])
    model.ir_version = 10
    return model.SerializeToString()


class CheckModelForRuntimeSnapshotTest(unittest.TestCase):
    def test_normal_graph_checker_receives_exact_snapshot_copy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "segment.onnx"
            graph_bytes = _model_bytes()
            source.write_bytes(graph_bytes)
            observed_paths: list[Path] = []

            def inspect_checker(path: str, *, full_check: bool) -> None:
                checker_path = Path(path)
                observed_paths.append(checker_path)
                self.assertFalse(full_check)
                self.assertNotEqual(checker_path, source)
                self.assertEqual(checker_path.parent, source.parent)
                self.assertEqual(checker_path.read_bytes(), graph_bytes)

            with patch.object(target.onnx.checker, "check_model", side_effect=inspect_checker):
                target.check_model_for_runtime(source)

            self.assertEqual(len(observed_paths), 1)
            self.assertFalse(observed_paths[0].exists())
            self.assertEqual(source.read_bytes(), graph_bytes)

    def test_custom_runtime_op_checker_is_derived_from_same_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "segment.onnx"
            graph_bytes = _model_bytes(custom_runtime_op=True)
            source.write_bytes(graph_bytes)
            observed_paths: list[Path] = []

            def inspect_checker(path: str, *, full_check: bool) -> None:
                checker_path = Path(path)
                observed_paths.append(checker_path)
                self.assertFalse(full_check)
                self.assertNotEqual(checker_path, source)
                checked = onnx.load_model(str(checker_path), load_external_data=False)
                node = checked.graph.node[0]
                self.assertEqual(node.op_type, "SimplifiedLayerNormalization")
                self.assertEqual(node.domain, "com.microsoft")
                self.assertIn("com.microsoft", {opset.domain for opset in checked.opset_import})

            with patch.object(target.onnx.checker, "check_model", side_effect=inspect_checker):
                target.check_model_for_runtime(source)

            self.assertEqual(len(observed_paths), 1)
            self.assertFalse(observed_paths[0].exists())
            original = onnx.load_model(io.BytesIO(source.read_bytes()), load_external_data=False)
            self.assertEqual(original.graph.node[0].domain, "")
            self.assertEqual(source.read_bytes(), graph_bytes)

    def test_snapshot_failure_happens_before_parse_or_checker(self) -> None:
        @contextmanager
        def fail_snapshot(*args: object, **kwargs: object):
            raise RuntimeError("unstable graph")
            yield  # pragma: no cover

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "segment.onnx"
            source.write_bytes(_model_bytes())
            with (
                patch.object(target, "open_regular_file_snapshot", fail_snapshot),
                patch.object(target.onnx, "load_model") as load_model,
                patch.object(target.onnx.checker, "check_model") as check_model,
            ):
                with self.assertRaisesRegex(RuntimeError, "unstable graph"):
                    target.check_model_for_runtime(source)

            load_model.assert_not_called()
            check_model.assert_not_called()


if __name__ == "__main__":
    unittest.main()
