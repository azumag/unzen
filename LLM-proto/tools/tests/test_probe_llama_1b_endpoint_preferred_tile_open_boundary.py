from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import probe_llama_1b_endpoint_preferred_tile_ort_cpu as probe  # noqa: E402


class PreferredTilePayloadOpenBoundaryTests(unittest.TestCase):
    def test_regular_payload_open_uses_nonblocking_and_cloexec_flags(self) -> None:
        payload = b"unzen-pinned-payload\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "payload-0000.bin"
            path.write_bytes(payload)
            real_open = os.open
            observed_flags: list[int] = []

            def capturing_open(candidate: os.PathLike[str] | str, flags: int, *args: object) -> int:
                observed_flags.append(flags)
                return real_open(candidate, flags, *args)

            with mock.patch.object(probe.os, "open", side_effect=capturing_open):
                fd, verified, _ = probe._open_pinned_payload(
                    path,
                    expected_bytes=len(payload),
                    expected_sha256=hashlib.sha256(payload).hexdigest(),
                )
            try:
                self.assertEqual(verified["byteLength"], len(payload))
            finally:
                os.close(fd)

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
    def test_regular_path_swapped_to_fifo_is_rejected_without_blocking_open(self) -> None:
        payload = b"payload-before-race"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "payload-0000.bin"
            moved = root / "payload-original.bin"
            path.write_bytes(payload)
            real_open = os.open

            def swap_then_open(candidate: os.PathLike[str] | str, flags: int, *args: object) -> int:
                self.assertTrue(
                    flags & os.O_NONBLOCK,
                    "payload pinning must request O_NONBLOCK before opening a raced path",
                )
                path.rename(moved)
                os.mkfifo(path)
                return real_open(candidate, flags, *args)

            with mock.patch.object(probe.os, "open", side_effect=swap_then_open):
                with self.assertRaisesRegex(RuntimeError, "opened physical payload is not regular"):
                    probe._open_pinned_payload(
                        path,
                        expected_bytes=len(payload),
                        expected_sha256=hashlib.sha256(payload).hexdigest(),
                    )


if __name__ == "__main__":
    unittest.main()
