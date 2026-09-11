from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import audit_multi_segment_capture as audit_module  # noqa: E402
import verify_multi_segment_capture_source as source_module  # noqa: E402


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

    def test_ordinary_relative_path_remains_valid(self) -> None:
        self.assertEqual(
            source_module._relative_path_text(
                "weights/chunk-0001.bin",
                field="source external-data location",
            ),
            "weights/chunk-0001.bin",
        )
        expected = [
            {
                "location": "weights/chunk-0001.bin",
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


if __name__ == "__main__":
    unittest.main()
