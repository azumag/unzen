from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import artifact_execution_snapshot as snapshot  # noqa: E402


class ArtifactExecutionSnapshotSharedPathTest(unittest.TestCase):
    def test_workspace_identity_delegates_to_shared_path_helper(self) -> None:
        root = Path("snapshot-root")
        with mock.patch.object(
            snapshot.execution_snapshot_paths,
            "workspace_identity",
            return_value=(11, 22),
        ) as shared:
            self.assertEqual(snapshot._snapshot_workspace_identity(root), (11, 22))
        shared.assert_called_once_with(root, label="artifact execution snapshot")

    def test_prepared_destination_delegates_to_shared_path_helper(self) -> None:
        root = Path("snapshot-root")
        identity = (11, 22)
        expected = (
            root / "weights" / "segment.onnx_data",
            7,
            "segment.onnx_data",
            ((('weights',), 33, 44),),
        )

        @contextmanager
        def shared_destination(*args: object, **kwargs: object):
            self.assertEqual(args, (root, ("weights", "segment.onnx_data"), identity))
            self.assertEqual(kwargs, {"label": "artifact execution snapshot"})
            yield expected

        with mock.patch.object(
            snapshot.execution_snapshot_paths,
            "prepared_destination",
            side_effect=shared_destination,
        ) as shared:
            with snapshot._prepared_snapshot_destination(
                root,
                ("weights", "segment.onnx_data"),
                identity,
            ) as observed:
                self.assertEqual(observed, expected)
        shared.assert_called_once()

    def test_parent_chain_delegates_to_shared_path_helper(self) -> None:
        root = Path("snapshot-root")
        identity = (11, 22)
        parents = ((('weights',), 33, 44),)
        with mock.patch.object(
            snapshot.execution_snapshot_paths,
            "assert_parent_chain",
        ) as shared:
            snapshot._assert_internal_parent_chain(root, identity, parents)
        shared.assert_called_once_with(
            root,
            identity,
            parents,
            label="artifact execution snapshot",
        )

    def test_parent_chain_preserves_generated_error_wording(self) -> None:
        root = Path("snapshot-root")
        identity = (11, 22)
        parents = ((('weights',), 33, 44),)
        with mock.patch.object(
            snapshot.execution_snapshot_paths,
            "assert_parent_chain",
            side_effect=RuntimeError(
                "artifact execution snapshot internal parent changed: weights"
            ),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "artifact execution snapshot internal parent changed during pinning: weights",
            ):
                snapshot._assert_internal_parent_chain(root, identity, parents)

    def test_rollback_unlink_delegates_to_shared_path_helper(self) -> None:
        destination = Path("snapshot-root/weights/segment.onnx_data")
        with mock.patch.object(
            snapshot.execution_snapshot_paths,
            "unlink_pinned_destination",
        ) as shared:
            snapshot._unlink_pinned_destination(destination, 7, "segment.onnx_data")
        shared.assert_called_once_with(destination, 7, "segment.onnx_data")


if __name__ == "__main__":
    unittest.main()
