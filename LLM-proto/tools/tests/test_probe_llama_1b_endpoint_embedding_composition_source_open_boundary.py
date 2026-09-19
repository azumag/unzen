from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import probe_llama_1b_endpoint_embedding_composition_ort_cpu as probe  # noqa: E402


class EmbeddingCompositionSourceOpenBoundaryTest(unittest.TestCase):
    def test_source_open_requests_safe_flags_and_hashes_exact_raw_bytes(self) -> None:
        raw = b"embedding\r\nsource\x1a\x00bytes\r\n"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model_q4.onnx_data"
            path.write_bytes(raw)
            fake_binary = 1 << 29
            real_open = os.open
            observed_flags: list[int] = []

            def checking_open(target: object, flags: int, *args: object, **kwargs: object) -> int:
                if Path(target) == path:
                    observed_flags.append(flags)
                    nonblock = getattr(os, "O_NONBLOCK", 0)
                    if nonblock:
                        self.assertTrue(flags & nonblock)
                    cloexec = getattr(os, "O_CLOEXEC", 0)
                    if cloexec:
                        self.assertTrue(flags & cloexec)
                    nofollow = getattr(os, "O_NOFOLLOW", 0)
                    if nofollow:
                        self.assertTrue(flags & nofollow)
                    self.assertTrue(flags & fake_binary)
                    flags &= ~fake_binary
                return real_open(target, flags, *args, **kwargs)

            with (
                mock.patch.object(probe.os, "O_BINARY", fake_binary, create=True),
                mock.patch.object(probe.os, "open", side_effect=checking_open),
            ):
                fd, opened = probe._open_pinned_source_external_data(path)
                try:
                    digest = probe._sha256_fd(fd, opened.st_size)
                    self.assertEqual(os.pread(fd, len(raw), 0), raw)
                finally:
                    os.close(fd)

            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())
            self.assertEqual(len(observed_flags), 1)

    @unittest.skipUnless(
        hasattr(os, "mkfifo") and bool(getattr(os, "O_NONBLOCK", 0)),
        "FIFO race regression requires POSIX mkfifo/O_NONBLOCK support",
    )
    def test_source_swap_to_fifo_fails_without_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model_q4.onnx_data"
            path.write_bytes(b"source")
            real_open = os.open
            swapped = False

            def swap_before_open(target: object, flags: int, *args: object, **kwargs: object) -> int:
                nonlocal swapped
                if Path(target) == path and not swapped:
                    self.assertTrue(
                        flags & os.O_NONBLOCK,
                        "source open must request O_NONBLOCK before a special-file race can occur",
                    )
                    path.unlink()
                    os.mkfifo(path, 0o600)
                    swapped = True
                return real_open(target, flags, *args, **kwargs)

            with (
                mock.patch.object(probe.os, "open", side_effect=swap_before_open),
                self.assertRaisesRegex(RuntimeError, "must remain a regular file"),
            ):
                probe._open_pinned_source_external_data(path)

            self.assertTrue(swapped)
            self.assertTrue(path.exists())
            self.assertFalse(path.is_file())


if __name__ == "__main__":
    unittest.main()
