from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import audit_multi_segment_capture as audit_module  # noqa: E402
import verify_multi_segment_artifact_snapshot as snapshot_module  # noqa: E402
import verify_multi_segment_artifacts as artifacts_module  # noqa: E402
import verify_multi_segment_capture_bundle as bundle_module  # noqa: E402
import verify_multi_segment_capture_source as source_module  # noqa: E402
import verify_multi_segment_capture_source_provenance as provenance_module  # noqa: E402


DIGEST = "0" * 64


class CaptureSourceWindowsDrivePathTest(unittest.TestCase):
    def test_source_relative_path_rejects_drive_relative_windows_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            source_module._relative_path_text(
                "C:payload.bin",
                field="source external-data location",
            )

    def test_source_external_entries_reject_drive_relative_windows_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            source_module._normalized_external_entries(
                [{"location": "C:payload.bin", "bytes": 1, "sha256": DIGEST}],
                field="split-manifest.sourceModel.externalData",
            )

    def test_complete_audit_rejects_drive_relative_windows_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            audit_module._source_external_data(
                [{"location": "C:payload.bin", "bytes": 1, "sha256": DIGEST}],
                field="source.sourceExternalData",
            )

    def test_source_provenance_rejects_drive_relative_windows_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            provenance_module._safe_relative(
                "C:payload.bin",
                field="split-manifest.sourceModel.externalData[0].location",
            )

    def test_capture_bundle_rejects_drive_relative_windows_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            bundle_module._safe_relative_path(
                Path.cwd(),
                "C:payload.bin",
                field="run-summary.artifacts.manifest",
            )

    def test_artifact_snapshot_rejects_drive_relative_windows_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            snapshot_module._safe_path(
                Path.cwd(),
                "C:payload.bin",
                field="segments[0].path",
            )

    def test_artifact_integrity_rejects_drive_relative_windows_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            artifacts_module._safe_relative_path(
                Path.cwd(),
                "C:payload.bin",
                field="segments[0].path",
            )

    def test_artifact_integrity_rejects_rooted_drive_less_windows_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            artifacts_module._safe_relative_path(
                Path.cwd(),
                r"\payload.bin",
                field="segments[0].path",
            )

    def test_ordinary_relative_path_remains_valid(self) -> None:
        relative = "weights/chunk-0001.bin"
        self.assertEqual(
            source_module._relative_path_text(
                relative,
                field="source external-data location",
            ),
            relative,
        )
        expected = [
            {
                "location": relative,
                "bytes": 1,
                "sha256": DIGEST,
            }
        ]
        self.assertEqual(
            source_module._normalized_external_entries(
                expected,
                field="split-manifest.sourceModel.externalData",
            ),
            expected,
        )
        self.assertEqual(
            audit_module._source_external_data(
                expected,
                field="source.sourceExternalData",
            ),
            expected,
        )
        self.assertEqual(
            provenance_module._safe_relative(
                relative,
                field="split-manifest.sourceModel.externalData[0].location",
            ),
            relative,
        )
        self.assertEqual(
            bundle_module._safe_relative_path(
                Path.cwd(),
                relative,
                field="run-summary.artifacts.manifest",
            ),
            (Path.cwd() / relative).resolve(),
        )
        snapshot_name, snapshot_path, snapshot_parts = snapshot_module._safe_path(
            Path.cwd(),
            relative,
            field="segments[0].path",
        )
        self.assertEqual(snapshot_name, relative)
        self.assertEqual(snapshot_path, (Path.cwd().resolve() / relative).absolute())
        self.assertEqual(snapshot_parts, tuple(Path(relative).parts))
        self.assertEqual(
            artifacts_module._safe_relative_path(
                Path.cwd(),
                relative,
                field="segments[0].path",
            ),
            (Path.cwd() / relative).resolve(),
        )


if __name__ == "__main__":
    unittest.main()
