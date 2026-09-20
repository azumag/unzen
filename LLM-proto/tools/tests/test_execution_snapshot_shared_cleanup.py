from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import artifact_execution_snapshot as artifact_snapshot  # noqa: E402
import execution_snapshot_internal_paths as internal_paths  # noqa: E402
import legacy_two_segment_artifact_execution_snapshot as legacy_snapshot  # noqa: E402
import source_model_execution_snapshot as source_snapshot  # noqa: E402


class ExecutionSnapshotSharedCleanupTest(unittest.TestCase):
    def test_matching_workspace_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "snapshot"
            root.mkdir()
            (root / "sentinel.txt").write_text("owned", encoding="utf-8")
            identity = internal_paths.workspace_identity(root, label="test snapshot")

            internal_paths.remove_verified_workspace(
                root,
                identity,
                label="test snapshot",
            )

            self.assertFalse(root.exists())

    def test_replaced_workspace_fails_closed_without_removing_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "snapshot"
            root.mkdir()
            identity = internal_paths.workspace_identity(root, label="test snapshot")

            original = base / "original"
            root.rename(original)
            root.mkdir()
            sentinel = root / "replacement.txt"
            sentinel.write_text("keep", encoding="utf-8")

            with self.assertRaisesRegex(
                RuntimeError,
                r"test snapshot workspace changed before cleanup:",
            ):
                internal_paths.remove_verified_workspace(
                    root,
                    identity,
                    label="test snapshot",
                )

            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
            self.assertTrue(original.is_dir())

    def test_path_specific_wrappers_delegate_with_stable_labels(self) -> None:
        root = Path("snapshot")
        identity = (11, 22)

        with mock.patch.object(source_snapshot, "remove_verified_workspace") as shared:
            source_snapshot._remove_verified_snapshot_root(root, identity)
            shared.assert_called_once_with(
                root,
                identity,
                label="source execution snapshot",
            )

        with mock.patch.object(legacy_snapshot, "remove_verified_workspace") as shared:
            legacy_snapshot._remove_verified_snapshot_root(root, identity)
            shared.assert_called_once_with(
                root,
                identity,
                label="legacy artifact execution snapshot",
            )

        with mock.patch.object(
            artifact_snapshot.execution_snapshot_paths,
            "remove_verified_workspace",
        ) as shared:
            artifact_snapshot._remove_verified_snapshot_root(root, identity)
            shared.assert_called_once_with(
                root,
                identity,
                label="artifact execution snapshot",
            )


if __name__ == "__main__":
    unittest.main()
