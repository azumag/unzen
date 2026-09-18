from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_kv_decode_evidence as verifier  # noqa: E402


class KvDecodeEvidenceBinaryModeTest(unittest.TestCase):
    def test_stable_reader_requests_binary_mode_and_returns_exact_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "evidence.bin"
            raw = b"line1\r\nline2\x1a\n"
            path.write_bytes(raw)
            fake_binary_flag = 1 << 29
            real_open = os.open
            observed: dict[str, object] = {}

            def capturing_open(candidate, flags, *args, **kwargs):
                observed["path"] = Path(candidate)
                observed["flags"] = flags
                return real_open(candidate, flags & ~fake_binary_flag, *args, **kwargs)

            with (
                mock.patch.object(verifier.os, "O_BINARY", fake_binary_flag, create=True),
                mock.patch.object(verifier.os, "open", side_effect=capturing_open),
            ):
                captured = verifier.read_stable_regular_file(path, max_bytes=1024)

            self.assertEqual(captured, raw)
            self.assertEqual(observed["path"], path)
            self.assertTrue(int(observed["flags"]) & fake_binary_flag)


if __name__ == "__main__":
    unittest.main()
