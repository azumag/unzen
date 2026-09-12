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
    def _write_external_model(
        self,
        model_path: Path,
        location: str = "weights.bin",
        *,
        offset: int = 0,
        length: int = 4,
    ) -> None:
        initializer = TensorProto()
        initializer.name = "weight"
        initializer.data_type = TensorProto.FLOAT
        initializer.dims.append(1)
        initializer.data_location = TensorProto.EXTERNAL
        for key, value in (
            ("location", location),
            ("offset", str(offset)),
            ("length", str(length)),
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

    def test_missing_source_does_not_create_destination(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "source"
            output_dir = root / "output"
            source_dir.mkdir()
            output_dir.mkdir()
            model_path = output_dir / "segment0.onnx"
            self._write_external_model(model_path)
            destination = output_dir / "segment0.onnx_data"

            with self.assertRaises(FileNotFoundError):
                repack_segment_external_data(
                    model_path,
                    source_dir,
                    destination.name,
                )

            self.assertFalse(destination.exists())

    def test_out_of_bounds_source_does_not_modify_existing_destination(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "source"
            output_dir = root / "output"
            source_dir.mkdir()
            output_dir.mkdir()

            source = source_dir / "weights.bin"
            source.write_bytes(b"\x00\x01")
            model_path = output_dir / "segment0.onnx"
            self._write_external_model(model_path, length=4)
            destination = output_dir / "segment0.onnx_data"
            existing = b"keep-existing-destination"
            destination.write_bytes(existing)

            with self.assertRaisesRegex(
                ValueError,
                "external-data range exceeds source file",
            ):
                repack_segment_external_data(
                    model_path,
                    source_dir,
                    destination.name,
                )

            self.assertEqual(destination.read_bytes(), existing)

    def test_rejects_cross_platform_unsafe_source_locations(self) -> None:
        unsafe = (
            "/abs/weights.bin",
            "../weights.bin",
            r"C:\weights.bin",
            r"\\server\share\weights.bin",
            "CON.bin",
            "LPT².dat",
            "weights.",
            "weights:stream.bin",
        )
        for location in unsafe:
            with self.subTest(location=location), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source_dir = root / "source"
                output_dir = root / "output"
                source_dir.mkdir()
                output_dir.mkdir()
                model_path = output_dir / "segment0.onnx"
                self._write_external_model(model_path, location)

                with self.assertRaisesRegex(
                    ValueError,
                    "unsafe source external-data location",
                ):
                    repack_segment_external_data(
                        model_path,
                        source_dir,
                        "segment0.onnx_data",
                    )

    def test_rejects_cross_platform_unsafe_output_locations(self) -> None:
        unsafe = (
            "",
            "/abs/segment0.onnx_data",
            "../segment0.onnx_data",
            r"C:\segment0.onnx_data",
            r"\\server\share\segment0.onnx_data",
            "CON.bin",
            "LPT².dat",
            "segment0.",
            "segment0:stream.bin",
        )
        for location in unsafe:
            with self.subTest(location=location), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source_dir = root / "source"
                output_dir = root / "output"
                source_dir.mkdir()
                output_dir.mkdir()
                (source_dir / "weights.bin").write_bytes(struct.pack("<f", 1.0))
                model_path = output_dir / "segment0.onnx"
                self._write_external_model(model_path)

                with self.assertRaisesRegex(
                    ValueError,
                    "unsafe output external-data location",
                ):
                    repack_segment_external_data(model_path, source_dir, location)

    def test_rejects_output_that_aliases_model_graph(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "source"
            output_dir = root / "output"
            source_dir.mkdir()
            output_dir.mkdir()
            (source_dir / "weights.bin").write_bytes(struct.pack("<f", 1.0))
            model_path = output_dir / "segment0.onnx"
            self._write_external_model(model_path)
            original_model = model_path.read_bytes()

            with self.assertRaisesRegex(
                ValueError,
                "output external-data path aliases model graph",
            ):
                repack_segment_external_data(
                    model_path,
                    source_dir,
                    model_path.name,
                )

            self.assertEqual(model_path.read_bytes(), original_model)

    def test_allows_nested_relative_source_and_output_locations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "source"
            output_dir = root / "output"
            (source_dir / "nested").mkdir(parents=True)
            (output_dir / "nested").mkdir(parents=True)
            original = struct.pack("<f", 6.25)
            (source_dir / "nested" / "weights.bin").write_bytes(original)
            model_path = output_dir / "segment0.onnx"
            self._write_external_model(model_path, "nested/weights.bin")

            result = repack_segment_external_data(
                model_path,
                source_dir,
                "nested/segment0.onnx_data",
            )

            self.assertIsNotNone(result)
            self.assertEqual(
                (output_dir / "nested" / "segment0.onnx_data").read_bytes(),
                original,
            )

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
