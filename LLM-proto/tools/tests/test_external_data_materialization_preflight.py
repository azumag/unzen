from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import split_llama_1b_onnx as splitter  # noqa: E402


class ExternalDataMaterializationPreflightTest(unittest.TestCase):
    def test_unsupported_mode_fails_before_location_preflight(self) -> None:
        with mock.patch.object(
            splitter,
            "_preflight_external_data_locations",
            side_effect=AssertionError("location preflight must not run"),
        ) as preflight_mock:
            with self.assertRaisesRegex(ValueError, "unsupported external data mode"):
                splitter.materialize_external_data(
                    Path("unused/model.onnx"),
                    Path("unused-output"),
                    ["weights/good.bin"],
                    "hardlink",
                )
        preflight_mock.assert_not_called()

    def test_malformed_locations_fail_before_filesystem_work(self) -> None:
        bad_locations: tuple[object, ...] = (
            "",
            Path("/escape.bin").as_posix(),
            "../escape.bin",
            "weights/../../escape.bin",
            None,
            1,
            [],
        )
        for bad_location in bad_locations:
            with self.subTest(location=bad_location), mock.patch.object(
                Path,
                "exists",
                side_effect=AssertionError("source/destination lookup must not run"),
            ) as exists_mock, mock.patch.object(
                Path,
                "mkdir",
                side_effect=AssertionError("destination mkdir must not run"),
            ) as mkdir_mock:
                with self.assertRaisesRegex(ValueError, "unsafe external data location"):
                    splitter.materialize_external_data(
                        Path("unused/model.onnx"),
                        Path("unused-output"),
                        ["weights/good.bin", bad_location],  # type: ignore[list-item]
                        "copy",
                    )
                exists_mock.assert_not_called()
                mkdir_mock.assert_not_called()

    def test_bad_later_location_cannot_partially_materialize_earlier_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_model = root / "source" / "model.onnx"
            source = source_model.parent / "weights" / "good.bin"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"good")
            output_dir = root / "output"

            with self.assertRaisesRegex(ValueError, "unsafe external data location"):
                splitter.materialize_external_data(
                    source_model,
                    output_dir,
                    ["weights/good.bin", "../escape.bin"],
                    "copy",
                )

            self.assertFalse((output_dir / "weights" / "good.bin").exists())
            self.assertFalse(output_dir.exists())

    def test_missing_later_source_cannot_mutate_earlier_destination(self) -> None:
        for mode in ("copy", "symlink"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                source_model = root / "source" / "model.onnx"
                source = source_model.parent / "weights" / "good.bin"
                source.parent.mkdir(parents=True)
                source.write_bytes(b"new")

                output_dir = root / "output"
                existing = output_dir / "weights" / "good.bin"
                existing.parent.mkdir(parents=True)
                existing.write_bytes(b"old")

                with self.assertRaisesRegex(FileNotFoundError, "external data file not found"):
                    splitter.materialize_external_data(
                        source_model,
                        output_dir,
                        ["weights/good.bin", "weights/missing.bin"],
                        mode,
                    )

                self.assertFalse(existing.is_symlink())
                self.assertEqual(existing.read_bytes(), b"old")
                self.assertFalse((output_dir / "weights" / "missing.bin").exists())

    def test_none_mode_skips_source_lookup_after_location_preflight(self) -> None:
        with mock.patch.object(
            Path,
            "exists",
            side_effect=AssertionError("none mode must not inspect source files"),
        ) as exists_mock:
            splitter.materialize_external_data(
                Path("unused/model.onnx"),
                Path("unused-output"),
                ["weights/nested/chunk.bin"],
                "none",
            )
        exists_mock.assert_not_called()

    def test_nested_relative_location_preserves_copy_symlink_and_none_modes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_model = root / "source" / "model.onnx"
            source = source_model.parent / "weights" / "nested" / "chunk.bin"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"payload")
            location = "weights/nested/chunk.bin"

            copy_dir = root / "copy"
            splitter.materialize_external_data(source_model, copy_dir, [location], "copy")
            copied = copy_dir / location
            self.assertTrue(copied.is_file())
            self.assertFalse(copied.is_symlink())
            self.assertEqual(copied.read_bytes(), b"payload")

            symlink_dir = root / "symlink"
            splitter.materialize_external_data(source_model, symlink_dir, [location], "symlink")
            linked = symlink_dir / location
            self.assertTrue(linked.is_symlink())
            self.assertEqual(linked.read_bytes(), b"payload")

            none_dir = root / "none"
            splitter.materialize_external_data(source_model, none_dir, [location], "none")
            self.assertFalse(none_dir.exists())


if __name__ == "__main__":
    unittest.main()
