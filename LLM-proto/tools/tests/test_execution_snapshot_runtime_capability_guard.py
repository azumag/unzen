from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import artifact_execution_snapshot as artifact_snapshot  # noqa: E402
import execution_snapshot_internal_paths as internal_paths  # noqa: E402
import legacy_two_segment_artifact_execution_snapshot as legacy_snapshot  # noqa: E402
import source_model_execution_snapshot as source_snapshot  # noqa: E402


class ExecutionSnapshotRuntimeCapabilityGuardTest(unittest.TestCase):
    def test_shared_mode_selector_matches_preflight_modes(self) -> None:
        self.assertEqual(
            internal_paths.execution_snapshot_mode(
                component_anchored=True,
                nofollow_hardlink=True,
                pathname_lstat=True,
            ),
            internal_paths.MODE_COMPONENT_ANCHORED,
        )
        self.assertEqual(
            internal_paths.execution_snapshot_mode(
                component_anchored=False,
                nofollow_hardlink=True,
                pathname_lstat=True,
            ),
            internal_paths.MODE_PATHNAME_FALLBACK,
        )
        self.assertEqual(
            internal_paths.execution_snapshot_mode(
                component_anchored=False,
                nofollow_hardlink=False,
                pathname_lstat=True,
            ),
            internal_paths.MODE_UNSUPPORTED,
        )
        self.assertEqual(
            internal_paths.execution_snapshot_mode(
                component_anchored=True,
                nofollow_hardlink=True,
                pathname_lstat=False,
            ),
            internal_paths.MODE_UNSUPPORTED,
        )

    def test_source_runtime_rejects_unsafe_fallback_before_preflight_or_workspace(self) -> None:
        with (
            mock.patch.object(internal_paths, "lstat_supported", return_value=True),
            mock.patch.object(internal_paths, "component_walk_supported", return_value=False),
            mock.patch.object(internal_paths, "nofollow_hardlink_supported", return_value=False),
            mock.patch.object(source_snapshot, "_preflight_source_model_identity") as preflight,
            mock.patch.object(source_snapshot.tempfile, "mkdtemp") as mkdtemp,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"source execution snapshot pathname fallback requires os\.link",
            ):
                with source_snapshot.verified_source_execution_snapshot(Path("model.onnx"), {}):
                    self.fail("unsupported runtime must not yield")

        preflight.assert_not_called()
        mkdtemp.assert_not_called()

    def test_legacy_runtime_rejects_unsafe_fallback_before_artifact_preflight_or_workspace(self) -> None:
        with (
            mock.patch.object(internal_paths, "lstat_supported", return_value=True),
            mock.patch.object(internal_paths, "component_walk_supported", return_value=False),
            mock.patch.object(internal_paths, "nofollow_hardlink_supported", return_value=False),
            mock.patch.object(legacy_snapshot, "_artifact_entries") as artifact_entries,
            mock.patch.object(legacy_snapshot.tempfile, "mkdtemp") as mkdtemp,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"legacy artifact execution snapshot pathname fallback requires os\.link",
            ):
                with legacy_snapshot.verified_legacy_two_segment_execution_snapshot(
                    Path("split-manifest.json"),
                    {},
                    Path("segment0.onnx"),
                    Path("segment1.onnx"),
                ):
                    self.fail("unsupported runtime must not yield")

        artifact_entries.assert_not_called()
        mkdtemp.assert_not_called()

    def test_generated_runtime_rejects_unsafe_fallback_before_verification_or_workspace(self) -> None:
        with (
            mock.patch.object(internal_paths, "lstat_supported", return_value=True),
            mock.patch.object(internal_paths, "component_walk_supported", return_value=False),
            mock.patch.object(internal_paths, "nofollow_hardlink_supported", return_value=False),
            mock.patch.object(artifact_snapshot, "_verify_execution_boundary") as verify_boundary,
            mock.patch.object(artifact_snapshot.tempfile, "mkdtemp") as mkdtemp,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"artifact execution snapshot pathname fallback requires os\.link",
            ):
                with artifact_snapshot.verified_artifact_execution_snapshot(
                    Path("split-manifest.json")
                ):
                    self.fail("unsupported runtime must not yield")

        verify_boundary.assert_not_called()
        mkdtemp.assert_not_called()

    def test_generated_runtime_rejects_missing_manifest_write_before_verification_or_workspace(self) -> None:
        with (
            mock.patch.object(internal_paths, "lstat_supported", return_value=True),
            mock.patch.object(internal_paths, "component_walk_supported", return_value=False),
            mock.patch.object(internal_paths, "nofollow_hardlink_supported", return_value=True),
            mock.patch.object(
                artifact_snapshot,
                "assert_manifest_write_supported",
                side_effect=RuntimeError(
                    "artifact execution snapshot requires manifest write capability"
                ),
            ) as manifest_guard,
            mock.patch.object(artifact_snapshot, "_verify_execution_boundary") as verify_boundary,
            mock.patch.object(artifact_snapshot.tempfile, "mkdtemp") as mkdtemp,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "artifact execution snapshot requires manifest write capability",
            ):
                with artifact_snapshot.verified_artifact_execution_snapshot(
                    Path("split-manifest.json")
                ):
                    self.fail("unsupported runtime must not yield")

        manifest_guard.assert_called_once_with(label="artifact execution snapshot")
        verify_boundary.assert_not_called()
        mkdtemp.assert_not_called()

    def test_runtime_guard_rejects_missing_generation_bound_cleanup(self) -> None:
        with (
            mock.patch.object(internal_paths, "lstat_supported", return_value=True),
            mock.patch.object(internal_paths, "component_walk_supported", return_value=True),
            mock.patch.object(internal_paths, "nofollow_hardlink_supported", return_value=True),
            mock.patch.object(
                internal_paths,
                "generation_bound_cleanup_supported",
                return_value=False,
            ),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"test snapshot requires generation-bound workspace cleanup support",
            ):
                internal_paths.assert_execution_snapshot_runtime_supported(
                    label="test snapshot"
                )

    def test_runtime_guard_allows_anchored_and_safe_fallback_modes(self) -> None:
        with (
            mock.patch.object(internal_paths, "lstat_supported", return_value=True),
            mock.patch.object(internal_paths, "component_walk_supported", return_value=True),
            mock.patch.object(internal_paths, "nofollow_hardlink_supported", return_value=True),
            mock.patch.object(
                internal_paths,
                "generation_bound_cleanup_supported",
                return_value=True,
            ),
        ):
            self.assertEqual(
                internal_paths.assert_execution_snapshot_runtime_supported(label="test snapshot"),
                internal_paths.MODE_COMPONENT_ANCHORED,
            )

        with (
            mock.patch.object(internal_paths, "lstat_supported", return_value=True),
            mock.patch.object(internal_paths, "component_walk_supported", return_value=False),
            mock.patch.object(internal_paths, "nofollow_hardlink_supported", return_value=True),
            mock.patch.object(
                internal_paths,
                "generation_bound_cleanup_supported",
                return_value=True,
            ),
        ):
            self.assertEqual(
                internal_paths.assert_execution_snapshot_runtime_supported(label="test snapshot"),
                internal_paths.MODE_PATHNAME_FALLBACK,
            )


if __name__ == "__main__":
    unittest.main()
