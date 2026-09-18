from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import source_file_snapshot as snapshot  # noqa: E402


class SourceFileSnapshotBinaryModeTest(unittest.TestCase):
    def test_pin_regular_file_requests_binary_mode_when_available(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            target = Path(raw_dir) / "source.bin"
            target.write_bytes(b"line1\r\nline2\x1a\n")

            fake_binary_flag = 1 << 29
            real_open = os.open
            observed: dict[str, object] = {}

            def capturing_open(path: os.PathLike[str] | str, flags: int, *args: object) -> int:
                observed["path"] = Path(path)
                observed["flags"] = flags
                return real_open(path, flags & ~fake_binary_flag, *args)

            with (
                patch.object(snapshot.os, "O_BINARY", fake_binary_flag, create=True),
                patch.object(snapshot.os, "open", side_effect=capturing_open),
            ):
                requested, resolved, _opened, fd = snapshot._pin_regular_file(
                    target,
                    label="source fixture",
                )
                os.close(fd)

            self.assertEqual(requested, target.absolute())
            self.assertEqual(resolved, target.resolve())
            self.assertEqual(observed["path"], target.resolve())
            self.assertTrue(int(observed["flags"]) & fake_binary_flag)


if __name__ == "__main__":
    unittest.main()
