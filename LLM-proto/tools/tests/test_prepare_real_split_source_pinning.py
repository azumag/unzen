from __future__ import annotations

import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import onnx
from onnx import TensorProto, helper

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_real_split as repack_module  # noqa: E402


class RepackSourceIdentityPinningTest(unittest.TestCase):
    def _write_external_model(self, model_path: Path, location: str) -> None:
        initializer = TensorProto()
        initializer.name = "weight"
        initializer.data_type = TensorProto.FLOAT
        initializer.dims.append(1)
        initializer.data_location = TensorProto.EXTERNAL
        for key, value in (("location", location), ("offset", "0"), ("length", "4")):
            entry = initializer.external_data.add()
            entry.key = key
            entry.value = value

        graph = helper.make_graph(
            [helper.make_node("Add", ["input", "weight"], ["output"])],
            "repack-source-pinning-fixture",
            [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1])],
            [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1])],
            initializer=[initializer],
        )
        model = helper.make_model(
            graph,
            producer_name="unzen-repack-source-pinning-fixture",
            opset_imports=[helper.make_opsetid("", 18)],
        )
        model.ir_version = 10
        onnx.save_model(model, str(model_path))

    def test_source_symlink_retarget_after_preflight_keeps_opened_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "source"
            output_dir = root / "output"
            source_dir.mkdir()
            output_dir.mkdir()

            original_bytes = struct.pack("<f", 1.25)
            replacement_bytes = struct.pack("<f", 9.75)
            original_target = source_dir / "original.bin"
            replacement_target = source_dir / "replacement.bin"
            original_target.write_bytes(original_bytes)
            replacement_target.write_bytes(replacement_bytes)
            source_link = source_dir / "weights.bin"
            try:
                source_link.symlink_to(original_target)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"symlink creation is unavailable: {error}")

            model_path = output_dir / "segment0.onnx"
            self._write_external_model(model_path, source_link.name)
            destination = output_dir / "segment0.onnx_data"
            open_destination = repack_module._open_repack_destination
            retargeted = False

            def retarget_then_open(path: Path, *, parent_fd: int | None = None):
                nonlocal retargeted
                source_link.unlink()
                source_link.symlink_to(replacement_target)
                retargeted = True
                return open_destination(path, parent_fd=parent_fd)

            with patch.object(
                repack_module,
                "_open_repack_destination",
                side_effect=retarget_then_open,
            ):
                result = repack_module.repack_segment_external_data(
                    model_path,
                    source_dir,
                    destination.name,
                )

            self.assertTrue(retargeted)
            self.assertIsNotNone(result)
            self.assertEqual(destination.read_bytes(), original_bytes)
            self.assertNotEqual(destination.read_bytes(), replacement_bytes)

    def test_fifo_source_is_rejected_before_destination_creation(self) -> None:
        if not hasattr(os, "mkfifo"):
            self.skipTest("FIFO creation is unavailable on this platform")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "source"
            output_dir = root / "output"
            source_dir.mkdir()
            output_dir.mkdir()

            source = source_dir / "weights.bin"
            os.mkfifo(source)
            model_path = output_dir / "segment0.onnx"
            self._write_external_model(model_path, source.name)
            destination = output_dir / "segment0.onnx_data"

            with self.assertRaisesRegex(
                ValueError,
                "source external-data must be a regular file",
            ):
                repack_module.repack_segment_external_data(
                    model_path,
                    source_dir,
                    destination.name,
                )

            self.assertFalse(destination.exists())

    def test_source_mutation_during_copy_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "source"
            output_dir = root / "output"
            source_dir.mkdir()
            output_dir.mkdir()

            source = source_dir / "weights.bin"
            source.write_bytes(struct.pack("<f", 3.5))
            model_path = output_dir / "segment0.onnx"
            self._write_external_model(model_path, source.name)
            destination = output_dir / "segment0.onnx_data"
            real_copy_range = repack_module._copy_range
            mutated = False

            def copy_then_mutate(source_handle, destination_handle, offset: int, length: int) -> None:
                nonlocal mutated
                real_copy_range(source_handle, destination_handle, offset, length)
                if not mutated:
                    with source.open("ab") as stream:
                        stream.write(b"mutation")
                    mutated = True

            with patch.object(
                repack_module,
                "_copy_range",
                side_effect=copy_then_mutate,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "source external-data changed during repack",
                ):
                    repack_module.repack_segment_external_data(
                        model_path,
                        source_dir,
                        destination.name,
                    )

            self.assertTrue(mutated)


if __name__ == "__main__":
    unittest.main()
