from __future__ import annotations

import os
from pathlib import Path
import sys
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


if __name__ == "__main__":
    unittest.main()
