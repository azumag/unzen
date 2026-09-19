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

import execution_snapshot_internal_paths as internal_paths  # noqa: E402


class ExecutionSnapshotInternalPathCapabilityTest(unittest.TestCase):
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
                internal_paths.os,
                "supports_dir_fd",
                dir_fd_functions,
                create=True,
            ),
            mock.patch.object(
                internal_paths.os,
                "supports_follow_symlinks",
                follow_symlink_functions,
                create=True,
            ),
            mock.patch.object(internal_paths.os, "O_DIRECTORY", 0, create=True),
            mock.patch.object(internal_paths.os, "O_NOFOLLOW", 0, create=True),
        ):
            return internal_paths.component_walk_supported()

    def _assert_fallback_capability_error(
        self,
        *,
        follow_symlink_functions: set[object],
        expected_fragment: str,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "snapshot"
            root.mkdir()
            identity = internal_paths.workspace_identity(root, label="test snapshot")
            dir_fd_functions = {
                os.open,
                os.mkdir,
                os.link,
                os.stat,
                os.unlink,
            }
            with (
                mock.patch.object(
                    internal_paths.os,
                    "supports_dir_fd",
                    dir_fd_functions,
                    create=True,
                ),
                mock.patch.object(
                    internal_paths.os,
                    "supports_follow_symlinks",
                    follow_symlink_functions,
                    create=True,
                ),
                mock.patch.object(internal_paths.os, "O_DIRECTORY", 0, create=True),
                mock.patch.object(internal_paths.os, "O_NOFOLLOW", 0, create=True),
            ):
                with self.assertRaisesRegex(RuntimeError, expected_fragment):
                    with internal_paths.prepared_destination(
                        root,
                        ("nested", "artifact.onnx"),
                        identity,
                        label="test snapshot",
                    ):
                        self.fail("unsafe pathname fallback must fail before yielding")

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

    def test_workspace_identity_uses_lstat_without_follow_symlink_keyword(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "snapshot"
            root.mkdir()
            expected = os.lstat(root)
            with mock.patch.object(
                internal_paths.os,
                "stat",
                side_effect=AssertionError("workspace fallback must not call os.stat"),
            ):
                self.assertEqual(
                    internal_paths.workspace_identity(root, label="test snapshot"),
                    (expected.st_dev, expected.st_ino),
                )

    def test_pathname_fallback_rejects_missing_nofollow_link_capability(self) -> None:
        self._assert_fallback_capability_error(
            follow_symlink_functions={os.stat},
            expected_fragment=r"missing no-follow filesystem capability: os\.link",
        )

    def test_pathname_fallback_rejects_missing_nofollow_stat_capability(self) -> None:
        self._assert_fallback_capability_error(
            follow_symlink_functions={os.link},
            expected_fragment=r"missing no-follow filesystem capability: os\.stat",
        )


if __name__ == "__main__":
    unittest.main()
