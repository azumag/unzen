from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_source as source_module  # noqa: E402
import verify_multi_segment_capture_source_provenance as provenance_module  # noqa: E402


DIGEST = "0" * 64
CONTROL_PATHS = (
    "weights/part\x00.bin",
    "weights/part\n.bin",
    "weights/part\x1f.bin",
    "weights/part\x7f.bin",
)


class CaptureSourceControlPathTest(unittest.TestCase):
    def test_source_relative_path_rejects_ascii_controls_and_del(self) -> None:
        for value in CONTROL_PATHS:
            with self.subTest(value=repr(value)):
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    source_module._relative_path_text(
                        value,
                        field="split-manifest.sourceModel.externalData[0].location",
                    )

    def test_provenance_relative_path_rejects_ascii_controls_and_del(self) -> None:
        for value in CONTROL_PATHS:
            with self.subTest(value=repr(value)):
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    provenance_module._safe_relative(
                        value,
                        field="split-manifest.sourceModel.externalData[0].location",
                    )

    def test_source_external_entries_reject_controls_before_normalization(self) -> None:
        for value in CONTROL_PATHS:
            with self.subTest(value=repr(value)):
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    source_module._normalized_external_entries(
                        [{"location": value, "bytes": 1, "sha256": DIGEST}],
                        field="split-manifest.sourceModel.externalData",
                    )

    def test_source_path_rejects_control_before_filesystem_resolution(self) -> None:
        with mock.patch.object(
            source_module.Path,
            "resolve",
            side_effect=AssertionError("filesystem resolution must not run"),
        ):
            with self.assertRaisesRegex(ValueError, "unsafe"):
                source_module._safe_source_relative_path(
                    Path("/tmp/model-root"),
                    "weights/part\x1f.bin",
                    field="split-manifest.sourceModel.externalData[0].location",
                )

    def test_capture_path_rejects_control_before_filesystem_resolution(self) -> None:
        with mock.patch.object(
            provenance_module.Path,
            "resolve",
            side_effect=AssertionError("filesystem resolution must not run"),
        ):
            with self.assertRaisesRegex(ValueError, "unsafe"):
                provenance_module._capture_path(
                    Path("/tmp/capture-root"),
                    "controls/run\x7f.json",
                    field="run-summary.artifacts.manifest",
                )

    def test_unicode_paths_remain_valid(self) -> None:
        value = "重み/モデル.bin"
        self.assertEqual(
            source_module._relative_path_text(
                value,
                field="split-manifest.sourceModel.externalData[0].location",
            ),
            value,
        )
        self.assertEqual(
            provenance_module._safe_relative(
                value,
                field="split-manifest.sourceModel.externalData[0].location",
            ),
            value,
        )


if __name__ == "__main__":
    unittest.main()
