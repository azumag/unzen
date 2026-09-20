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

    def _generation_bound_cleanup_supported(
        self,
        *,
        dir_fd_functions: set[object] | None = None,
        follow_symlink_functions: set[object] | None = None,
        fd_functions: set[object] | None = None,
    ) -> bool:
        with (
            mock.patch.object(
                internal_paths.os,
                "supports_dir_fd",
                dir_fd_functions
                if dir_fd_functions is not None
                else {os.open, os.stat, os.unlink, os.rmdir},
                create=True,
            ),
            mock.patch.object(
                internal_paths.os,
                "supports_follow_symlinks",
                follow_symlink_functions
                if follow_symlink_functions is not None
                else {os.stat},
                create=True,
            ),
            mock.patch.object(
                internal_paths.os,
                "supports_fd",
                fd_functions if fd_functions is not None else {os.scandir},
                create=True,
            ),
            mock.patch.object(internal_paths.os, "O_DIRECTORY", 0, create=True),
            mock.patch.object(internal_paths.os, "O_NOFOLLOW", 0, create=True),
        ):
            return internal_paths.generation_bound_cleanup_supported()

    def _fallback_context(
        self,
        *,
        follow_symlink_functions: set[object],
    ):
        dir_fd_functions = {
            os.open,
            os.mkdir,
            os.link,
            os.stat,
            os.unlink,
        }
        return (
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
        )

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

    def test_missing_link_callable_disables_nofollow_hardlink_and_component_walk(self) -> None:
        with mock.patch.object(internal_paths.os, "link", None):
            self.assertFalse(internal_paths.nofollow_hardlink_supported())
            self.assertFalse(internal_paths.component_walk_supported())

    def test_missing_stat_callable_disables_nofollow_stat_and_component_walk(self) -> None:
        with mock.patch.object(internal_paths.os, "stat", None):
            self.assertFalse(internal_paths.nofollow_stat_supported())
            self.assertFalse(internal_paths.component_walk_supported())

    def test_missing_anchored_operation_disables_component_walk(self) -> None:
        for name in ("open", "mkdir", "unlink", "fstat", "close"):
            with self.subTest(name=name), mock.patch.object(internal_paths.os, name, None):
                self.assertFalse(internal_paths.component_walk_supported())

    def test_full_capability_set_enables_generation_bound_cleanup(self) -> None:
        self.assertTrue(self._generation_bound_cleanup_supported())

    def test_missing_cleanup_operation_disables_generation_bound_cleanup(self) -> None:
        for name in ("open", "stat", "fstat", "scandir", "unlink", "rmdir", "close"):
            with self.subTest(name=name), mock.patch.object(internal_paths.os, name, None):
                self.assertFalse(internal_paths.generation_bound_cleanup_supported())

    def test_cleanup_requires_descriptor_backed_scandir(self) -> None:
        self.assertFalse(self._generation_bound_cleanup_supported(fd_functions=set()))

    def test_cleanup_requires_descriptor_relative_rmdir(self) -> None:
        self.assertFalse(
            self._generation_bound_cleanup_supported(
                dir_fd_functions={os.open, os.stat, os.unlink},
            )
        )

    def test_cleanup_requires_nofollow_stat(self) -> None:
        self.assertFalse(
            self._generation_bound_cleanup_supported(
                follow_symlink_functions=set(),
            )
        )

    def test_lstat_capability_tracks_callable_presence(self) -> None:
        self.assertTrue(internal_paths.lstat_supported())
        with mock.patch.object(internal_paths.os, "lstat", None):
            self.assertFalse(internal_paths.lstat_supported())

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
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "snapshot"
            root.mkdir()
            identity = internal_paths.workspace_identity(root, label="test snapshot")
            patches = self._fallback_context(follow_symlink_functions={os.stat})
            with patches[0], patches[1], patches[2], patches[3]:
                with self.assertRaisesRegex(
                    RuntimeError,
                    r"missing no-follow filesystem capability: os\.link",
                ):
                    with internal_paths.prepared_destination(
                        root,
                        ("nested", "artifact.onnx"),
                        identity,
                        label="test snapshot",
                    ):
                        self.fail("unsafe pathname fallback must fail before yielding")

    def test_pathname_fallback_allows_missing_nofollow_stat_capability(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "snapshot"
            root.mkdir()
            identity = internal_paths.workspace_identity(root, label="test snapshot")
            patches = self._fallback_context(follow_symlink_functions={os.link})
            with patches[0], patches[1], patches[2], patches[3]:
                with internal_paths.prepared_destination(
                    root,
                    ("nested", "artifact.onnx"),
                    identity,
                    label="test snapshot",
                ) as (destination, parent_fd, leaf_name, parents):
                    self.assertEqual(destination, root / "nested" / "artifact.onnx")
                    self.assertIsNone(parent_fd)
                    self.assertEqual(leaf_name, "artifact.onnx")
                    self.assertEqual(len(parents), 1)


if __name__ == "__main__":
    unittest.main()
