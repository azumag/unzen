from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_onnx as verifier_module  # noqa: E402


class VerifyMultiSegmentOnnxWindowsDrivePathTest(unittest.TestCase):
    def test_rejects_drive_relative_windows_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            verifier_module._safe_relative_path(
                Path.cwd(),
                "C:payload.bin",
                field="sourceModel.externalData[0].location",
            )

    def test_rejects_rooted_drive_less_windows_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe"):
            verifier_module._safe_relative_path(
                Path.cwd(),
                r"\payload.bin",
                field="sourceModel.externalData[0].location",
            )

    def test_rejects_windows_alternate_data_stream_path(self) -> None:
        for value in ("payload.bin:stream", "weights/payload.bin:stream"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    verifier_module._safe_relative_path(
                        Path.cwd(),
                        value,
                        field="sourceModel.externalData[0].location",
                    )

    def test_rejects_windows_reserved_or_trimmed_component(self) -> None:
        for value in (
            "NUL",
            "nul.bin",
            "weights/CON",
            "weights/com1.onnx",
            "weights/LPT9",
            "weights/COM¹.log",
            "weights/lpt².bin",
            "weights/payload.",
            "weights/payload ",
        ):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    verifier_module._safe_relative_path(
                        Path.cwd(),
                        value,
                        field="sourceModel.externalData[0].location",
                    )

    def test_ordinary_relative_path_remains_valid(self) -> None:
        relative = "weights/chunk-0001.bin"
        self.assertEqual(
            verifier_module._safe_relative_path(
                Path.cwd(),
                relative,
                field="sourceModel.externalData[0].location",
            ),
            (Path.cwd() / relative).resolve(),
        )


if __name__ == "__main__":
    unittest.main()
