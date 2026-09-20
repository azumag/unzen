from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import execution_snapshot_manifest_write as manifest_write  # noqa: E402


class ExecutionSnapshotManifestWriteCapabilityTest(unittest.TestCase):
    def test_current_host_support_is_detected(self) -> None:
        self.assertTrue(manifest_write.manifest_write_supported())

    def test_missing_required_callable_is_unsupported(self) -> None:
        for name in ("open", "write", "close"):
            with self.subTest(name=name), mock.patch.object(manifest_write.os, name, None):
                self.assertFalse(manifest_write.manifest_write_supported())

    def test_missing_required_create_flag_is_unsupported(self) -> None:
        for name in ("O_WRONLY", "O_CREAT", "O_EXCL"):
            with self.subTest(name=name), mock.patch.object(manifest_write.os, name, None):
                self.assertFalse(manifest_write.manifest_write_supported())

    def test_assertion_fails_closed_with_deterministic_message(self) -> None:
        with mock.patch.object(manifest_write.os, "write", None):
            with self.assertRaisesRegex(
                RuntimeError,
                r"generated snapshot requires os\.open/os\.write/os\.close plus O_WRONLY/O_CREAT/O_EXCL",
            ):
                manifest_write.assert_manifest_write_supported(label="generated snapshot")

    def test_optional_no_follow_and_cloexec_flags_are_not_required(self) -> None:
        # `_snapshot_create_flags()` already treats these as optional. The
        # capability gate must not accidentally make generated snapshots
        # stricter than the runtime implementation.
        with (
            mock.patch.object(manifest_write.os, "O_NOFOLLOW", None, create=True),
            mock.patch.object(manifest_write.os, "O_CLOEXEC", None, create=True),
        ):
            self.assertTrue(manifest_write.manifest_write_supported())


if __name__ == "__main__":
    unittest.main()
