from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import artifact_execution_snapshot as snapshot  # noqa: E402


class ArtifactExecutionSnapshotCapabilityTest(unittest.TestCase):
    def _component_walk_supported(
        self,
        *,
        follow_symlink_functions: set[object],
    ) -> bool:
        dir_fd_functions = {
            os.open,
            os.mkdir,
            os.link,
            os.stat,
            os.unlink,
        }
        with (
            mock.patch.object(
                snapshot.os,
                "supports_dir_fd",
                dir_fd_functions,
                create=True,
            ),
            mock.patch.object(
                snapshot.os,
                "supports_follow_symlinks",
                follow_symlink_functions,
                create=True,
            ),
            mock.patch.object(snapshot.os, "O_DIRECTORY", 0, create=True),
            mock.patch.object(snapshot.os, "O_NOFOLLOW", 0, create=True),
        ):
            return snapshot._internal_component_walk_supported()

    def test_full_capability_set_enables_component_walk(self) -> None:
        self.assertTrue(
            self._component_walk_supported(
                follow_symlink_functions={os.link, os.stat},
            )
        )

    def test_missing_link_follow_symlink_support_disables_component_walk(self) -> None:
        self.assertFalse(
            self._component_walk_supported(
                follow_symlink_functions={os.stat},
            )
        )

    def test_missing_stat_follow_symlink_support_disables_component_walk(self) -> None:
        self.assertFalse(
            self._component_walk_supported(
                follow_symlink_functions={os.link},
            )
        )

    def test_pathname_fallback_accepts_link_nofollow_without_stat_nofollow(self) -> None:
        with mock.patch.object(
            snapshot.os,
            "supports_follow_symlinks",
            {os.link},
            create=True,
        ):
            self.assertTrue(snapshot._pathname_hard_link_supported())
            snapshot._require_pathname_hard_link_support()

    def test_pathname_fallback_rejects_missing_link_nofollow(self) -> None:
        with mock.patch.object(
            snapshot.os,
            "supports_follow_symlinks",
            {os.stat},
            create=True,
        ):
            self.assertFalse(snapshot._pathname_hard_link_supported())
            with self.assertRaisesRegex(RuntimeError, r"os\.link\(\.\.\., follow_symlinks=False\)"):
                snapshot._require_pathname_hard_link_support()

    def test_workspace_identity_uses_lstat_without_stat_nofollow(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            expected = os.lstat(path)
            with mock.patch.object(
                snapshot.os,
                "stat",
                side_effect=AssertionError("pathname os.stat must not be used"),
            ):
                observed = snapshot._snapshot_workspace_identity(path)
            self.assertEqual(observed, (expected.st_dev, expected.st_ino))

    def test_execution_fingerprint_uses_lstat_without_stat_nofollow(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "segment.onnx"
            path.write_bytes(b"onnx")
            expected = os.lstat(path)
            with mock.patch.object(
                snapshot.os,
                "stat",
                side_effect=AssertionError("pathname os.stat must not be used"),
            ):
                observed = snapshot._artifact_execution_fingerprint(path, label="segment")
            self.assertEqual(
                observed,
                (
                    expected.st_mode,
                    expected.st_dev,
                    expected.st_ino,
                    expected.st_nlink,
                    expected.st_size,
                    expected.st_mtime_ns,
                    expected.st_ctime_ns,
                ),
            )

    def test_missing_link_nofollow_fails_before_artifact_verification(self) -> None:
        manifest = Path("split-manifest.json")
        with (
            mock.patch.object(snapshot, "_internal_component_walk_supported", return_value=False),
            mock.patch.object(snapshot, "_pathname_hard_link_supported", return_value=False),
            mock.patch.object(snapshot, "_verify_execution_boundary") as verify_boundary,
        ):
            with self.assertRaisesRegex(RuntimeError, r"os\.link\(\.\.\., follow_symlinks=False\)"):
                with snapshot.verified_artifact_execution_snapshot(manifest):
                    self.fail("unsupported pathname fallback must not yield evidence")
            verify_boundary.assert_not_called()


if __name__ == "__main__":
    unittest.main()
