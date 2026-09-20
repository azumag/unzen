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
        expected = os.open in getattr(os, "supports_dir_fd", set())
        self.assertEqual(manifest_write.manifest_write_supported(), expected)

    def test_missing_required_callable_is_unsupported(self) -> None:
        for name in ("open", "write", "close"):
            with self.subTest(name=name), mock.patch.object(manifest_write.os, name, None):
                self.assertFalse(manifest_write.manifest_write_supported())

    def test_manifest_write_requires_descriptor_relative_open(self) -> None:
        with mock.patch.object(manifest_write.os, "supports_dir_fd", set(), create=True):
            self.assertFalse(manifest_write.manifest_write_supported())

    def test_malformed_dir_fd_capability_container_is_unsupported(self) -> None:
        with mock.patch.object(manifest_write.os, "supports_dir_fd", None, create=True):
            self.assertFalse(manifest_write.manifest_write_supported())

    def test_missing_required_create_flag_is_unsupported(self) -> None:
        for name in ("O_WRONLY", "O_CREAT", "O_EXCL"):
            with self.subTest(name=name), mock.patch.object(manifest_write.os, name, None):
                self.assertFalse(manifest_write.manifest_write_supported())

    def test_required_create_flags_must_be_real_integers(self) -> None:
        for name in ("O_WRONLY", "O_CREAT", "O_EXCL"):
            with self.subTest(name=name), mock.patch.object(manifest_write.os, name, True):
                self.assertFalse(manifest_write.manifest_write_supported())

    def test_optional_flag_placeholder_is_unsupported(self) -> None:
        for name in ("O_NOFOLLOW", "O_CLOEXEC"):
            with self.subTest(name=name), mock.patch.object(
                manifest_write.os,
                name,
                None,
                create=True,
            ):
                self.assertFalse(manifest_write.manifest_write_supported())

    def test_missing_optional_flag_is_allowed(self) -> None:
        self.assertTrue(
            manifest_write._integer_flag(
                "UNZEN_TEST_OPTIONAL_FLAG_THAT_DOES_NOT_EXIST",
                required=False,
            )
        )

    def test_assertion_fails_closed_with_deterministic_message(self) -> None:
        with mock.patch.object(manifest_write.os, "write", None):
            with self.assertRaisesRegex(
                RuntimeError,
                r"generated snapshot requires descriptor-relative os\.open/os\.write/os\.close plus integer O_WRONLY/O_CREAT/O_EXCL",
            ):
                manifest_write.assert_manifest_write_supported(label="generated snapshot")


if __name__ == "__main__":
    unittest.main()
