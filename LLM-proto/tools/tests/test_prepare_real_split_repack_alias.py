from __future__ import annotations

import struct
import sys
import tempfile
import unittest
from pathlib import Path

import onnx
from onnx import TensorProto, helper

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from prepare_real_split import repack_segment_external_data  # noqa: E402


class RepackSourceAliasSafetyTest(unittest.TestCase):
    def _write_external_model(self, model_path: Path, location: str = "weights.bin") -> None:
        initializer = TensorProto()
        initializer.name = "weight"
        initializer.data_type = TensorProto.FLOAT
        initializer.dims.append(1)
        initializer.data_location = TensorProto.EXTERNAL
        for key, value in (
            ("location", location),
            ("offset", "0"),
            ("length", "4"),
        ):
            entry = initializer.external_data.add()
            entry.key = key
            entry.value = value

        graph = helper.make_graph(
            [helper.make_node("Add", ["input", "weight"], ["output"])],
            "repack-alias-fixture",
            [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1])],
            [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1])],
            initializer=[initializer],
        )
        model = helper.make_model(
            graph,
            producer_name="unzen-repack-alias-fixture",
            opset_imports=[helper.make_opsetid("", 18)],
        )
        model.ir_version = 10
        onnx.save_model(model, str(model_path))

    def test_rejects_direct_source_alias_before_truncating_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "weights.bin"
            original = struct.pack("<f", 1.25)
            source.write_bytes(original)
            model_path = root / "segment0.onnx"
            self._write_external_model(model_path)

            with self.assertRaisesRegex(
                ValueError,
                "output external-data path aliases source external-data",
            ):
                repack_segment_external_data(model_path, root, "weights.bin")

            self.assertEqual(source.read_bytes(), original)

    def test_rejects_symlink_alias_before_truncating_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "source"
            output_dir = root / "output"
            source_dir.mkdir()
            output_dir.mkdir()

            source = source_dir / "weights.bin"
            original = struct.pack("<f", 2.5)
            source.write_bytes(original)
            model_path = output_dir / "segment0.onnx"
            self._write_external_model(model_path)

            destination = output_dir / "segment0.onnx_data"
            try:
                destination.symlink_to(source)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation is unavailable on this platform")

            with self.assertRaisesRegex(
                ValueError,
                "output external-data path aliases source external-data",
            ):
                repack_segment_external_data(
                    model_path,
                    source_dir,
                    destination.name,
                )

            self.assertEqual(source.read_bytes(), original)
            self.assertTrue(destination.is_symlink())

    def test_repacks_to_distinct_destination_without_mutating_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "source"
            output_dir = root / "output"
            source_dir.mkdir()
            output_dir.mkdir()

            source = source_dir / "weights.bin"
            original = struct.pack("<f", 3.75)
            source.write_bytes(original)
            model_path = output_dir / "segment0.onnx"
            self._write_external_model(model_path)

            result = repack_segment_external_data(
                model_path,
                source_dir,
                "segment0.onnx_data",
            )

            self.assertIsNotNone(result)
            self.assertEqual(result["bytes"], len(original))
            self.assertEqual(result["uniqueSourceRanges"], 1)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual((output_dir / "segment0.onnx_data").read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
