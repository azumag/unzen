from __future__ import annotations

import hashlib
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

import verify_multi_segment_capture_source_provenance as provenance  # noqa: E402


class CaptureSourceProvenanceBinaryModeTest(unittest.TestCase):
    def test_stable_json_object_requests_binary_mode_and_hashes_exact_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "control.json"
            raw = b'{\r\n  "line": "one\\r\\ntwo",\r\n  "control": "\\u001a"\r\n}\r\n'
            path.write_bytes(raw)
            fake_binary_flag = 1 << 29
            real_open = os.open
            observed: dict[str, object] = {}

            def capturing_open(candidate, flags, *args, **kwargs):
                observed["path"] = Path(candidate)
                observed["flags"] = flags
                return real_open(candidate, flags & ~fake_binary_flag, *args, **kwargs)

            with (
                mock.patch.object(provenance.os, "O_BINARY", fake_binary_flag, create=True),
                mock.patch.object(provenance.os, "open", side_effect=capturing_open),
            ):
                value, digest = provenance._stable_json_object(path, field="control")

            self.assertEqual(value, {"line": "one\r\ntwo", "control": "\x1a"})
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())
            self.assertEqual(observed["path"], path)
            self.assertTrue(int(observed["flags"]) & fake_binary_flag)


if __name__ == "__main__":
    unittest.main()
