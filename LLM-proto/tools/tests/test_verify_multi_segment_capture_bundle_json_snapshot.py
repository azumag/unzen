from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from verify_multi_segment_capture_bundle import _json_snapshot  # noqa: E402


class VerifyMultiSegmentCaptureBundleJsonSnapshotTest(unittest.TestCase):
    def test_returns_object_and_digest_from_exact_same_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "run-summary.json"
            raw = b'{"kind":"example","status":"pass"}\n'
            target.write_bytes(raw)

            value, digest = _json_snapshot(target, field="run summary")

            self.assertEqual(value, {"kind": "example", "status": "pass"})
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())

    def test_path_replacement_after_open_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "same-machine-evidence.json"
            replacement = root / "replacement.json"
            target.write_text('{"snapshot":"original"}\n', encoding="utf-8")
            replacement.write_text('{"snapshot":"replacement"}\n', encoding="utf-8")
            original_os_open = os.open
            replaced = False

            def replace_after_open(path, flags, *args, **kwargs):
                nonlocal replaced
                fd = original_os_open(path, flags, *args, **kwargs)
                if Path(path) == target and not replaced:
                    os.replace(replacement, target)
                    replaced = True
                return fd

            with patch("verify_multi_segment_capture_bundle.os.open", replace_after_open):
                with self.assertRaisesRegex(RuntimeError, "changed between path check and open"):
                    _json_snapshot(target, field="same-machine evidence")

            self.assertTrue(replaced)

    def test_in_place_mutation_while_reading_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "run-summary.json"
            target.write_text('{"status":"pass"}\n', encoding="utf-8")
            original_read = os.read
            mutated = False

            def mutate_after_read(fd: int, size: int) -> bytes:
                nonlocal mutated
                chunk = original_read(fd, size)
                if chunk and not mutated:
                    with target.open("ab") as writer:
                        writer.write(b" ")
                    mutated = True
                return chunk

            with patch("verify_multi_segment_capture_bundle.os.read", mutate_after_read):
                with self.assertRaisesRegex(RuntimeError, "changed while being read"):
                    _json_snapshot(target, field="run summary")

            self.assertTrue(mutated)

    def test_missing_and_invalid_utf8_json_keep_useful_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            missing = root / "missing.json"
            with self.assertRaisesRegex(FileNotFoundError, "run summary not found"):
                _json_snapshot(missing, field="run summary")

            invalid = root / "invalid.json"
            invalid.write_bytes(b"{\xff}")
            with self.assertRaisesRegex(ValueError, "not valid UTF-8 JSON"):
                _json_snapshot(invalid, field="run summary")

    def test_non_regular_inputs_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / "directory.json"
            directory.mkdir()
            with self.assertRaisesRegex(ValueError, "must be a regular file"):
                _json_snapshot(directory, field="run summary")

            if hasattr(os, "mkfifo"):
                fifo = root / "fifo.json"
                os.mkfifo(fifo)
                with self.assertRaisesRegex(ValueError, "must be a regular file"):
                    _json_snapshot(fifo, field="same-machine evidence")


if __name__ == "__main__":
    unittest.main()
