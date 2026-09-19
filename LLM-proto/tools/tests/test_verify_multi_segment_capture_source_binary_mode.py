from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_source as source_module  # noqa: E402


FAKE_O_BINARY = 1 << 29


class VerifyMultiSegmentCaptureSourceBinaryModeTest(unittest.TestCase):
    @staticmethod
    def _recording_open(calls: list[tuple[str, int, int | None]]):
        real_open = os.open

        def recording_open(
            path: os.PathLike[str] | str,
            flags: int,
            mode: int = 0o777,
            *,
            dir_fd: int | None = None,
        ) -> int:
            calls.append((os.fspath(path), flags, dir_fd))
            real_flags = flags & ~FAKE_O_BINARY
            if dir_fd is None:
                return real_open(path, real_flags, mode)
            return real_open(path, real_flags, mode, dir_fd=dir_fd)

        return recording_open

    def test_portable_source_payload_requests_binary_mode_and_hashes_exact_bytes(self) -> None:
        payload = b"graph\r\nbytes\x1aafter-control\r\n"
        with tempfile.TemporaryDirectory() as raw_dir:
            source = Path(raw_dir) / "model.onnx"
            source.write_bytes(payload)
            open_calls: list[tuple[str, int, int | None]] = []

            with (
                patch.object(source_module.os, "O_BINARY", FAKE_O_BINARY, create=True),
                patch.object(
                    source_module.os,
                    "open",
                    side_effect=self._recording_open(open_calls),
                ),
            ):
                size, digest = source_module._stable_identity(
                    source,
                    field="full model graph",
                )

            self.assertEqual(size, len(payload))
            self.assertEqual(digest, hashlib.sha256(payload).hexdigest())
            self.assertEqual(len(open_calls), 1)
            self.assertTrue(open_calls[0][1] & FAKE_O_BINARY)

    @unittest.skipUnless(
        source_module._component_walk_supported(),
        "platform does not support anchored dirfd traversal",
    )
    def test_anchored_payload_requests_binary_mode_but_directory_opens_do_not(self) -> None:
        payload = b"weights\r\nchunk\x1astill-data\r\n"
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            nested = root / "weights"
            nested.mkdir()
            target = nested / "model.data"
            target.write_bytes(payload)

            root_fd, root_stat = source_module._open_directory_anchor(root)
            open_calls: list[tuple[str, int, int | None]] = []
            try:
                with (
                    patch.object(source_module.os, "O_BINARY", FAKE_O_BINARY, create=True),
                    patch.object(
                        source_module.os,
                        "open",
                        side_effect=self._recording_open(open_calls),
                    ),
                ):
                    size, digest = source_module._stable_identity_at(
                        root_fd,
                        ("weights", "model.data"),
                        field="source external data weights/model.data",
                    )
                    source_module._assert_directory_anchor(root, root_stat)
            finally:
                os.close(root_fd)

            self.assertEqual(size, len(payload))
            self.assertEqual(digest, hashlib.sha256(payload).hexdigest())

            payload_calls = [call for call in open_calls if call[0] == "model.data"]
            directory_calls = [call for call in open_calls if call[0] == "weights"]
            self.assertEqual(len(payload_calls), 1)
            self.assertGreaterEqual(len(directory_calls), 2)
            self.assertTrue(payload_calls[0][1] & FAKE_O_BINARY)
            self.assertTrue(
                all(not (flags & FAKE_O_BINARY) for _path, flags, _dir_fd in directory_calls)
            )


if __name__ == "__main__":
    unittest.main()
