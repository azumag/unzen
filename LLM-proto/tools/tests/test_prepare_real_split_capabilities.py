from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import prepare_real_split as repack  # noqa: E402


class RepackFilesystemCapabilityTests(unittest.TestCase):
    def test_component_walk_rejects_malformed_supports_dir_fd(self) -> None:
        with patch.object(repack.os, "supports_dir_fd", None):
            self.assertFalse(repack._destination_component_walk_supported())

    def test_component_walk_rejects_malformed_required_flag(self) -> None:
        with patch.object(repack.os, "O_DIRECTORY", None):
            self.assertFalse(repack._destination_component_walk_supported())

    def test_component_walk_rejects_malformed_present_optional_flag(self) -> None:
        if not hasattr(repack.os, "O_CLOEXEC"):
            self.skipTest("O_CLOEXEC is absent on this host")
        with patch.object(repack.os, "O_CLOEXEC", None):
            self.assertFalse(repack._destination_component_walk_supported())

    def test_component_walk_allows_absent_optional_flags(self) -> None:
        if not repack._destination_component_walk_supported():
            self.skipTest("component-anchored destination traversal is unavailable")

        removed: dict[str, int] = {}
        try:
            for name in ("O_CLOEXEC", "O_NONBLOCK"):
                if hasattr(repack.os, name):
                    value = getattr(repack.os, name)
                    if type(value) is int:
                        removed[name] = value
                        delattr(repack.os, name)
            self.assertTrue(repack._destination_component_walk_supported())
        finally:
            for name, value in removed.items():
                setattr(repack.os, name, value)

    def test_destination_open_rejects_malformed_optional_flag_before_open(self) -> None:
        if not hasattr(repack.os, "O_CLOEXEC"):
            self.skipTest("O_CLOEXEC is absent on this host")
        with (
            patch.object(repack.os, "O_CLOEXEC", None),
            patch.object(repack.os, "open") as open_mock,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "repack destination open flag os.O_CLOEXEC must be an integer",
            ):
                repack._open_repack_destination(Path("segment0.onnx_data"))
        open_mock.assert_not_called()

    def test_source_open_rejects_malformed_optional_flag_without_raw_type_error(self) -> None:
        if not hasattr(repack.os, "O_NOFOLLOW"):
            self.skipTest("O_NOFOLLOW is absent on this host")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "weights.bin"
            path.write_bytes(b"weights")
            with (
                patch.object(repack.os, "O_NOFOLLOW", None),
                patch.object(repack.os, "open") as open_mock,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "repack source open flag os.O_NOFOLLOW must be an integer",
                ):
                    repack._open_repack_source(path)
            open_mock.assert_not_called()

    def test_measurement_open_reuses_validated_read_flags(self) -> None:
        if not hasattr(repack.os, "O_NONBLOCK"):
            self.skipTest("O_NONBLOCK is absent on this host")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "segment0.onnx_data"
            path.write_bytes(b"payload")
            snapshot = repack._file_snapshot(path.lstat())
            with (
                patch.object(repack.os, "O_NONBLOCK", None),
                patch.object(repack.os, "open") as open_mock,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "repack measurement open flag os.O_NONBLOCK must be an integer",
                ):
                    repack._measure_repacked_output(path, expected_snapshot=snapshot)
            open_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
