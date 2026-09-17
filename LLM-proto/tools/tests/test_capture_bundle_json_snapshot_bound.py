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

import verify_multi_segment_capture_bundle as bundle_module  # noqa: E402


class CaptureBundleJsonSnapshotBoundTest(unittest.TestCase):
    def test_oversized_metadata_is_rejected_before_open(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run-summary.json"
            path.write_bytes(b'{"a":1}\n ')

            with patch.object(bundle_module.os, "open", wraps=os.open) as opened:
                with self.assertRaisesRegex(ValueError, "exceeds 8 bytes"):
                    bundle_module._json_snapshot(
                        path,
                        field="run summary",
                        max_bytes=8,
                    )

            opened.assert_not_called()

    def test_exact_limit_metadata_remains_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run-summary.json"
            payload = b'{"a":1}\n'
            self.assertEqual(len(payload), 8)
            path.write_bytes(payload)

            value, digest = bundle_module._json_snapshot(
                path,
                field="run summary",
                max_bytes=len(payload),
            )

            self.assertEqual(value, {"a": 1})
            self.assertEqual(digest, hashlib.sha256(payload).hexdigest())

    def test_growth_past_limit_is_rejected_during_descriptor_read(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "same-machine-evidence.json"
            path.write_bytes(b'{"a":1}')
            original_read = os.read
            appended = False

            def growing_read(fd: int, size: int) -> bytes:
                nonlocal appended
                block = original_read(fd, size)
                if block and not appended:
                    appended = True
                    with path.open("ab") as output:
                        output.write(b"xx")
                        output.flush()
                return block

            with patch.object(bundle_module.os, "read", side_effect=growing_read):
                with self.assertRaisesRegex(ValueError, "grew beyond 8 bytes"):
                    bundle_module._json_snapshot(
                        path,
                        field="same-machine evidence",
                        max_bytes=8,
                    )

            self.assertTrue(appended)

    def test_invalid_snapshot_limit_is_rejected_before_filesystem_access(self) -> None:
        with patch.object(bundle_module.os, "lstat") as lstat:
            for invalid in (0, -1, True, 1.5, "8"):
                with self.subTest(invalid=invalid):
                    with self.assertRaisesRegex(ValueError, "max_bytes must be a positive integer"):
                        bundle_module._json_snapshot(
                            Path("unused.json"),
                            field="metadata",
                            max_bytes=invalid,  # type: ignore[arg-type]
                        )
            lstat.assert_not_called()


if __name__ == "__main__":
    unittest.main()
