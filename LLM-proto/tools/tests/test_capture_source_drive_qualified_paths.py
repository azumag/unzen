from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import audit_multi_segment_capture as audit_module  # noqa: E402
import verify_multi_segment_capture_source as source_module  # noqa: E402


class CaptureSourceDriveQualifiedPathTest(unittest.TestCase):
    @staticmethod
    def _external_data(location: str) -> list[dict[str, object]]:
        return [
            {
                "location": location,
                "bytes": 1,
                "sha256": "a" * 64,
            }
        ]

    def test_source_relative_path_rejects_windows_drive_relative_paths(self) -> None:
        for value in ("C:payload.bin", r"D:nested\payload.bin"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    source_module._relative_path_text(value, field="source path")

    def test_source_external_metadata_rejects_windows_drive_relative_paths(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            source_module._normalized_external_entries(
                self._external_data("C:payload.bin"),
                field="source.externalData",
            )

    def test_complete_audit_external_metadata_rejects_windows_drive_relative_paths(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            audit_module._source_external_data(
                self._external_data("C:payload.bin"),
                field="source.sourceExternalData",
            )

    def test_portable_relative_paths_remain_valid(self) -> None:
        value = "nested/payload.bin"
        self.assertEqual(
            source_module._relative_path_text(value, field="source path"),
            value,
        )
        expected = self._external_data(value)
        self.assertEqual(
            source_module._normalized_external_entries(
                expected,
                field="source.externalData",
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
