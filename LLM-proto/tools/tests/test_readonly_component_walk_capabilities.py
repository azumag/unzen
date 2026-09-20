from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import readonly_component_walk  # noqa: E402
import verify_multi_segment_artifact_snapshot as artifact_snapshot  # noqa: E402
import verify_multi_segment_capture_source as capture_source  # noqa: E402


class ReadonlyComponentWalkCapabilityTest(unittest.TestCase):
    def _supported(
        self,
        *,
        dir_fd_functions: set[object],
        follow_symlink_functions: set[object],
    ) -> bool:
        with (
            patch.object(readonly_component_walk.os, "supports_dir_fd", dir_fd_functions),
            patch.object(
                readonly_component_walk.os,
                "supports_follow_symlinks",
                follow_symlink_functions,
            ),
            patch.object(readonly_component_walk.os, "O_DIRECTORY", 0, create=True),
            patch.object(readonly_component_walk.os, "O_NOFOLLOW", 0, create=True),
        ):
            return readonly_component_walk.component_walk_supported()

    def test_read_only_requirements_do_not_require_write_operations(self) -> None:
        self.assertTrue(
            self._supported(
                dir_fd_functions={readonly_component_walk.os.open, readonly_component_walk.os.stat},
                follow_symlink_functions={readonly_component_walk.os.stat},
            )
        )

    def test_missing_stat_dir_fd_support_disables_component_walk(self) -> None:
        self.assertFalse(
            self._supported(
                dir_fd_functions={readonly_component_walk.os.open},
                follow_symlink_functions={readonly_component_walk.os.stat},
            )
        )

    def test_missing_no_follow_stat_support_disables_component_walk(self) -> None:
        self.assertFalse(
            self._supported(
                dir_fd_functions={readonly_component_walk.os.open, readonly_component_walk.os.stat},
                follow_symlink_functions=set(),
            )
        )

    def test_malformed_supports_dir_fd_disables_component_walk(self) -> None:
        with patch.object(readonly_component_walk.os, "supports_dir_fd", None, create=True):
            self.assertFalse(readonly_component_walk.component_walk_supported())

    def test_malformed_supports_follow_symlinks_disables_component_walk(self) -> None:
        with patch.object(
            readonly_component_walk.os,
            "supports_follow_symlinks",
            None,
            create=True,
        ):
            self.assertFalse(readonly_component_walk.component_walk_supported())

    def test_missing_open_function_disables_component_walk(self) -> None:
        with patch.object(readonly_component_walk.os, "open", None):
            self.assertFalse(readonly_component_walk.component_walk_supported())

    def test_missing_stat_function_disables_component_walk(self) -> None:
        with patch.object(readonly_component_walk.os, "stat", None):
            self.assertFalse(readonly_component_walk.component_walk_supported())

    def test_non_callable_open_function_disables_component_walk(self) -> None:
        with patch.object(readonly_component_walk.os, "open", object()):
            self.assertFalse(readonly_component_walk.component_walk_supported())

    def test_non_callable_stat_function_disables_component_walk(self) -> None:
        with patch.object(readonly_component_walk.os, "stat", object()):
            self.assertFalse(readonly_component_walk.component_walk_supported())

    def test_malformed_required_open_flag_disables_component_walk(self) -> None:
        for name in ("O_RDONLY", "O_DIRECTORY", "O_NOFOLLOW"):
            with (
                self.subTest(name=name),
                patch.object(readonly_component_walk.os, name, None, create=True),
            ):
                self.assertFalse(readonly_component_walk.component_walk_supported())

    def test_malformed_present_optional_open_flag_disables_component_walk(self) -> None:
        for name in ("O_CLOEXEC", "O_NONBLOCK"):
            with (
                self.subTest(name=name),
                patch.object(readonly_component_walk.os, name, None, create=True),
            ):
                self.assertFalse(readonly_component_walk.component_walk_supported())

    def test_absent_optional_open_flag_remains_supported_by_flag_probe(self) -> None:
        self.assertTrue(
            readonly_component_walk._integer_flag(
                "UNZEN_TEST_ABSENT_OPTIONAL_OPEN_FLAG",
                required=False,
            )
        )

    def test_both_verifier_wrappers_delegate_to_shared_predicate(self) -> None:
        with patch.object(
            readonly_component_walk,
            "component_walk_supported",
            return_value=True,
        ) as predicate:
            self.assertTrue(artifact_snapshot._component_walk_supported())
            self.assertTrue(capture_source._component_walk_supported())

        self.assertEqual(predicate.call_count, 2)


if __name__ == "__main__":
    unittest.main()
