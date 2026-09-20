from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import execution_snapshot_internal_paths as internal_paths  # noqa: E402


class ExecutionSnapshotInternalPathCapabilityTest(unittest.TestCase):
    def _component_walk_supported(self) -> bool:
        os_module = internal_paths.os
        with (
            mock.patch.object(
                os_module,
                "supports_dir_fd",
                {os_module.open, os_module.mkdir, os_module.link, os_module.stat, os_module.unlink},
            ),
            mock.patch.object(
                os_module,
                "supports_follow_symlinks",
                {os_module.link, os_module.stat},
            ),
            mock.patch.object(os_module, "O_DIRECTORY", 0, create=True),
            mock.patch.object(os_module, "O_NOFOLLOW", 0, create=True),
        ):
            return internal_paths.component_walk_supported()

    def test_full_capability_set_is_preserved(self) -> None:
        self.assertTrue(self._component_walk_supported())

    def test_missing_link_disables_nofollow_hardlink_and_component_walk(self) -> None:
        with mock.patch.object(internal_paths.os, "link", None):
            self.assertFalse(internal_paths.nofollow_hardlink_supported())
            self.assertFalse(internal_paths.component_walk_supported())

    def test_missing_stat_disables_nofollow_stat_and_component_walk(self) -> None:
        with mock.patch.object(internal_paths.os, "stat", None):
            self.assertFalse(internal_paths.nofollow_stat_supported())
            self.assertFalse(internal_paths.component_walk_supported())

    def test_missing_anchored_operation_disables_component_walk(self) -> None:
        for name in ("open", "mkdir", "unlink", "fstat", "close"):
            with self.subTest(name=name), mock.patch.object(internal_paths.os, name, None):
                self.assertFalse(internal_paths.component_walk_supported())

    def test_nofollow_predicates_preserve_membership_contract(self) -> None:
        os_module = internal_paths.os
        with mock.patch.object(os_module, "supports_follow_symlinks", {os_module.link, os_module.stat}):
            self.assertTrue(internal_paths.nofollow_hardlink_supported())
            self.assertTrue(internal_paths.nofollow_stat_supported())

        with mock.patch.object(os_module, "supports_follow_symlinks", set()):
            self.assertFalse(internal_paths.nofollow_hardlink_supported())
            self.assertFalse(internal_paths.nofollow_stat_supported())


if __name__ == "__main__":
    unittest.main()
