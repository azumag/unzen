from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import split_llama_1b_onnx as splitter  # noqa: E402


class ExternalDataMaterializationFileTypePreflightTest(unittest.TestCase):
    def test_later_directory_source_cannot_mutate_earlier_destination(self) -> None:
        for mode in ("copy", "symlink"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                source_model = root / "source" / "model.onnx"
                source = source_model.parent / "weights" / "good.bin"
                source.parent.mkdir(parents=True)
                source.write_bytes(b"new")
                invalid_source = source_model.parent / "weights" / "directory.bin"
                invalid_source.mkdir()

                output_dir = root / "output"
                existing = output_dir / "weights" / "good.bin"
                existing.parent.mkdir(parents=True)
                existing.write_bytes(b"old")

                with self.assertRaisesRegex(OSError, "external data source is not a regular file"):
                    splitter.materialize_external_data(
                        source_model,
                        output_dir,
                        ["weights/good.bin", "weights/directory.bin"],
                        mode,
                    )

                self.assertFalse(existing.is_symlink())
                self.assertEqual(existing.read_bytes(), b"old")
                self.assertFalse((output_dir / "weights" / "directory.bin").is_symlink())

    def test_symlink_to_regular_source_remains_supported(self) -> None:
        for mode in ("copy", "symlink"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                source_model = root / "source" / "model.onnx"
                target = source_model.parent / "payload.bin"
                target.parent.mkdir(parents=True)
                target.write_bytes(b"payload")
                source = source_model.parent / "weights" / "alias.bin"
                source.parent.mkdir()
                source.symlink_to(Path("..") / "payload.bin")

                output_dir = root / "output"
                splitter.materialize_external_data(
                    source_model,
                    output_dir,
                    ["weights/alias.bin"],
                    mode,
                )

                materialized = output_dir / "weights" / "alias.bin"
                self.assertEqual(materialized.read_bytes(), b"payload")
                if mode == "copy":
                    self.assertFalse(materialized.is_symlink())
                else:
                    self.assertTrue(materialized.is_symlink())


if __name__ == "__main__":
    unittest.main()
