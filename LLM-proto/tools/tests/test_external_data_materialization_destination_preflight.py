from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import split_llama_1b_onnx as splitter  # noqa: E402


class ExternalDataMaterializationDestinationPreflightTest(unittest.TestCase):
    def _write_source(self, source_model: Path, location: str, payload: bytes) -> None:
        source = source_model.parent / location
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(payload)

    def test_later_destination_directory_cannot_mutate_earlier_destination(self) -> None:
        for mode in ("copy", "symlink"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                source_model = root / "source" / "model.onnx"
                self._write_source(source_model, "weights/good.bin", b"new-good")
                self._write_source(source_model, "weights/blocked.bin", b"new-blocked")

                output_dir = root / "output"
                earlier = output_dir / "weights" / "good.bin"
                earlier.parent.mkdir(parents=True)
                earlier.write_bytes(b"old-good")
                blocked = output_dir / "weights" / "blocked.bin"
                blocked.mkdir()

                with self.assertRaisesRegex(
                    IsADirectoryError,
                    "external data destination is a directory",
                ):
                    splitter.materialize_external_data(
                        source_model,
                        output_dir,
                        ["weights/good.bin", "weights/blocked.bin"],
                        mode,
                    )

                self.assertFalse(earlier.is_symlink())
                self.assertEqual(earlier.read_bytes(), b"old-good")
                self.assertTrue(blocked.is_dir())

    def test_later_blocking_parent_file_cannot_mutate_earlier_destination(self) -> None:
        for mode in ("copy", "symlink"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                source_model = root / "source" / "model.onnx"
                self._write_source(source_model, "weights/good.bin", b"new-good")
                self._write_source(source_model, "blocked/chunk.bin", b"new-blocked")

                output_dir = root / "output"
                earlier = output_dir / "weights" / "good.bin"
                earlier.parent.mkdir(parents=True)
                earlier.write_bytes(b"old-good")
                blocking_parent = output_dir / "blocked"
                blocking_parent.write_bytes(b"parent-file")

                with self.assertRaisesRegex(
                    NotADirectoryError,
                    "external data destination parent is not a directory",
                ):
                    splitter.materialize_external_data(
                        source_model,
                        output_dir,
                        ["weights/good.bin", "blocked/chunk.bin"],
                        mode,
                    )

                self.assertFalse(earlier.is_symlink())
                self.assertEqual(earlier.read_bytes(), b"old-good")
                self.assertEqual(blocking_parent.read_bytes(), b"parent-file")


if __name__ == "__main__":
    unittest.main()
