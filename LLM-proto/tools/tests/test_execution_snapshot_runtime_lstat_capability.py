from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import artifact_execution_snapshot as artifact_snapshot  # noqa: E402
import legacy_two_segment_artifact_execution_snapshot as legacy_snapshot  # noqa: E402
import source_model_execution_snapshot as source_snapshot  # noqa: E402


class ExecutionSnapshotRuntimeLstatCapabilityTest(unittest.TestCase):
    def test_source_snapshot_rejects_missing_lstat_before_workspace_or_evidence(self) -> None:
        with (
            mock.patch.object(source_snapshot.os, "lstat", None),
            mock.patch.object(source_snapshot.tempfile, "mkdtemp") as mkdtemp,
            mock.patch.object(source_snapshot, "_measure_source_model_identity") as measure,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"source execution snapshot requires os\.lstat",
            ):
                with source_snapshot.verified_source_execution_snapshot(Path("model.onnx"), {}):
                    self.fail("missing lstat must fail before yielding")

        mkdtemp.assert_not_called()
        measure.assert_not_called()

    def test_legacy_snapshot_rejects_missing_lstat_before_artifact_preflight_or_workspace(self) -> None:
        with (
            mock.patch.object(legacy_snapshot.os, "lstat", None),
            mock.patch.object(legacy_snapshot, "_artifact_entries") as artifact_entries,
            mock.patch.object(legacy_snapshot.tempfile, "mkdtemp") as mkdtemp,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"legacy artifact execution snapshot requires os\.lstat",
            ):
                with legacy_snapshot.verified_legacy_two_segment_execution_snapshot(
                    Path("split-manifest.json"),
                    {},
                    Path("segment0.onnx"),
                    Path("segment1.onnx"),
                ):
                    self.fail("missing lstat must fail before yielding")

        artifact_entries.assert_not_called()
        mkdtemp.assert_not_called()

    def test_generated_snapshot_rejects_missing_lstat_before_verification_or_workspace(self) -> None:
        with (
            mock.patch.object(artifact_snapshot.os, "lstat", None),
            mock.patch.object(artifact_snapshot, "_verify_execution_boundary") as verify_boundary,
            mock.patch.object(artifact_snapshot.tempfile, "mkdtemp") as mkdtemp,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"artifact execution snapshot requires os\.lstat",
            ):
                with artifact_snapshot.verified_artifact_execution_snapshot(
                    Path("split-manifest.json")
                ):
                    self.fail("missing lstat must fail before yielding")

        verify_boundary.assert_not_called()
        mkdtemp.assert_not_called()


if __name__ == "__main__":
    unittest.main()
