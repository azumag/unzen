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

import prepare_budgeted_multi_split_atomic as atomic  # noqa: E402


class AtomicManifestBinaryModeTest(unittest.TestCase):
    def _capture_binary_open(self, reader_name: str) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "split-manifest.json"
            raw = b'{"line":"one\r\ntwo","control":"\x1a"}\r\n'
            manifest.write_bytes(raw)
            fake_binary_flag = 1 << 29
            real_open = os.open
            observed: dict[str, object] = {}

            def capturing_open(path, flags, *args, **kwargs):
                observed["path"] = Path(path)
                observed["flags"] = flags
                return real_open(path, flags & ~fake_binary_flag, *args, **kwargs)

            with (
                mock.patch.object(atomic.os, "O_BINARY", fake_binary_flag, create=True),
                mock.patch.object(atomic.os, "open", side_effect=capturing_open),
            ):
                reader = getattr(atomic, reader_name)
                result = reader(manifest)

            captured = result[0] if isinstance(result, tuple) else result
            self.assertEqual(captured, raw)
            self.assertEqual(observed["path"], manifest)
            self.assertTrue(int(observed["flags"]) & fake_binary_flag)

    def test_previous_manifest_snapshot_requests_binary_mode_when_available(self) -> None:
        self._capture_binary_open("_read_previous_manifest_snapshot")

    def test_staged_manifest_snapshot_requests_binary_mode_when_available(self) -> None:
        self._capture_binary_open("_read_staged_manifest_snapshot")


if __name__ == "__main__":
    unittest.main()
