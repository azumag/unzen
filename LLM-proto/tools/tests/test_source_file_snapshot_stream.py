from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import source_file_snapshot as target


class SourceFileSnapshotStreamTests(unittest.TestCase):
    def test_stream_snapshot_reads_exact_bytes(self) -> None:
        payload = b"raw\r\nsource\x1abytes"
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "weights.bin"
            path.write_bytes(payload)

            with target.open_regular_file_snapshot(path, label="external data") as (
                stream,
                opened,
            ):
                self.assertEqual(opened.st_size, len(payload))
                self.assertEqual(stream.read(), payload)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink requires OS support")
    def test_requested_symlink_retarget_is_rejected_before_stream_is_yielded(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            first = root / "first.bin"
            second = root / "second.bin"
            requested = root / "requested.bin"
            first.write_bytes(b"first")
            second.write_bytes(b"second")
            try:
                requested.symlink_to(first.name)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error}")

            real_open = os.open
            retargeted = False
            yielded = False

            def open_then_retarget(
                name: os.PathLike[str] | str,
                flags: int,
                *args: object,
                **kwargs: object,
            ) -> int:
                nonlocal retargeted
                fd = real_open(name, flags, *args, **kwargs)
                if not retargeted and Path(name) == first.resolve():
                    retargeted = True
                    requested.unlink()
                    requested.symlink_to(second.name)
                return fd

            with patch.object(target.os, "open", side_effect=open_then_retarget):
                with self.assertRaisesRegex(RuntimeError, "requested path changed"):
                    with target.open_regular_file_snapshot(
                        requested, label="external data"
                    ) as (stream, _):
                        yielded = True
                        stream.read()

            self.assertTrue(retargeted)
            self.assertFalse(yielded)


if __name__ == "__main__":
    unittest.main()
