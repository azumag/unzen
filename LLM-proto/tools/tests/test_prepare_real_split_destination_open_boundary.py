from __future__ import annotations

import errno
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


class RepackDestinationOpenBoundaryTests(unittest.TestCase):
    def test_regular_destination_open_uses_nonblocking_and_cloexec_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "segment0.onnx_data"
            path.write_bytes(b"old payload")
            real_open = os.open
            observed_flags: list[int] = []

            def capturing_open(candidate, flags: int, *args):
                observed_flags.append(flags)
                return real_open(candidate, flags, *args)

            with patch.object(repack.os, "open", side_effect=capturing_open):
                with repack._open_repack_destination(path) as destination:
                    destination.write(b"new payload")

        self.assertEqual(len(observed_flags), 1)
        if hasattr(os, "O_NONBLOCK"):
            self.assertTrue(observed_flags[0] & os.O_NONBLOCK)
        if hasattr(os, "O_CLOEXEC"):
            self.assertTrue(observed_flags[0] & os.O_CLOEXEC)
        if hasattr(os, "O_NOFOLLOW"):
            self.assertTrue(observed_flags[0] & os.O_NOFOLLOW)

    @unittest.skipUnless(
        hasattr(os, "mkfifo") and hasattr(os, "O_NONBLOCK"),
        "FIFO replacement regression requires POSIX mkfifo/O_NONBLOCK",
    )
    def test_regular_destination_swapped_to_fifo_fails_before_truncate(self) -> None:
        original = b"must remain intact"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "segment0.onnx_data"
            moved = root / "segment0-original.onnx_data"
            path.write_bytes(original)
            real_open = os.open

            def swap_then_open(candidate, flags: int, *args):
                self.assertTrue(
                    flags & os.O_NONBLOCK,
                    "destination open must request O_NONBLOCK before touching a raced path",
                )
                path.rename(moved)
                os.mkfifo(path)
                return real_open(candidate, flags, *args)

            with (
                patch.object(repack.os, "open", side_effect=swap_then_open),
                patch.object(repack.os, "ftruncate", wraps=os.ftruncate) as truncate,
            ):
                with self.assertRaises(OSError) as raised:
                    repack._open_repack_destination(path)

            self.assertEqual(raised.exception.errno, errno.ENXIO)
            truncate.assert_not_called()
            self.assertEqual(moved.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
