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

import verify_endpoint_payload_materialization as verifier  # noqa: E402


class VerifyEndpointPayloadOpenBoundaryTest(unittest.TestCase):
    def _open_payload_directory(self, payload_dir: Path) -> int:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        flags |= getattr(os, "O_CLOEXEC", 0)
        return os.open(payload_dir, flags)

    def test_payload_hash_requests_safe_flags_and_hashes_exact_raw_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            payload_dir = Path(directory)
            payload = payload_dir / "payload-0000.bin"
            raw = b"first\r\nsecond\x1a\x00tail\r\n"
            payload.write_bytes(raw)
            directory_fd = self._open_payload_directory(payload_dir)
            real_open = os.open
            fake_binary = 1 << 29
            observed_flags: list[int] = []

            def checking_open(
                path: object,
                flags: int,
                mode: int = 0o777,
                *,
                dir_fd: int | None = None,
            ) -> int:
                if os.fspath(path) == payload.name and dir_fd == directory_fd:
                    observed_flags.append(flags)
                    nonblock = getattr(os, "O_NONBLOCK", 0)
                    if nonblock:
                        self.assertTrue(flags & nonblock)
                    self.assertTrue(flags & fake_binary)
                    cloexec = getattr(os, "O_CLOEXEC", 0)
                    nofollow = getattr(os, "O_NOFOLLOW", 0)
                    if cloexec:
                        self.assertTrue(flags & cloexec)
                    if nofollow:
                        self.assertTrue(flags & nofollow)
                    flags &= ~fake_binary
                return real_open(path, flags, mode, dir_fd=dir_fd)

            try:
                with (
                    mock.patch.object(verifier.os, "O_BINARY", fake_binary, create=True),
                    mock.patch.object(verifier.os, "open", side_effect=checking_open),
                ):
                    digest = verifier._sha256_payload_at(
                        directory_fd,
                        payload.name,
                        path=payload,
                        buffer_bytes=3,
                    )
            finally:
                os.close(directory_fd)

            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())
            self.assertEqual(len(observed_flags), 1)

    @unittest.skipUnless(
        hasattr(os, "mkfifo") and bool(getattr(os, "O_NONBLOCK", 0)),
        "FIFO race regression requires POSIX mkfifo/O_NONBLOCK support",
    )
    def test_payload_swap_to_fifo_fails_without_blocking_before_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            payload_dir = Path(directory)
            payload = payload_dir / "payload-0000.bin"
            payload.write_bytes(b"payload")
            expected_signature = verifier._file_stat_signature(payload.stat())
            directory_fd = self._open_payload_directory(payload_dir)
            real_open = os.open
            swapped = False

            def swap_before_open(
                path: object,
                flags: int,
                mode: int = 0o777,
                *,
                dir_fd: int | None = None,
            ) -> int:
                nonlocal swapped
                if os.fspath(path) == payload.name and dir_fd == directory_fd and not swapped:
                    self.assertTrue(
                        flags & os.O_NONBLOCK,
                        "payload open must request O_NONBLOCK before a special-file race can occur",
                    )
                    os.unlink(payload.name, dir_fd=directory_fd)
                    os.mkfifo(payload.name, 0o600, dir_fd=directory_fd)
                    swapped = True
                return real_open(path, flags, mode, dir_fd=dir_fd)

            try:
                with (
                    mock.patch.object(verifier.os, "open", side_effect=swap_before_open),
                    self.assertRaisesRegex(FileNotFoundError, "materialized payload not found"),
                ):
                    verifier._sha256_payload_at(
                        directory_fd,
                        payload.name,
                        path=payload,
                        expected_stat_signature=expected_signature,
                    )
            finally:
                os.close(directory_fd)

            self.assertTrue(swapped)
            self.assertTrue(payload.exists())
            self.assertFalse(payload.is_file())


if __name__ == "__main__":
    unittest.main()
