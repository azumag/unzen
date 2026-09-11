from __future__ import annotations

import sys
import unittest
from pathlib import Path

from onnx import TensorProto

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from multi_segment_onnx import _external_range  # noqa: E402


class MultiSegmentOnnxWindowsDrivePathTest(unittest.TestCase):
    @staticmethod
    def _external_initializer(location: str) -> TensorProto:
        initializer = TensorProto()
        initializer.name = "weight"
        initializer.data_location = TensorProto.EXTERNAL
        for key, value in (
            ("location", location),
            ("offset", "0"),
            ("length", "16"),
        ):
            entry = initializer.external_data.add()
            entry.key = key
            entry.value = value
        return initializer

    def test_rejects_drive_qualified_relative_location(self) -> None:
        initializer = self._external_initializer("C:payload.bin")

        with self.assertRaisesRegex(ValueError, "unsafe external-data location"):
            _external_range(initializer)

    def test_rejects_rooted_drive_less_location(self) -> None:
        initializer = self._external_initializer(r"\payload.bin")

        with self.assertRaisesRegex(ValueError, "unsafe external-data location"):
            _external_range(initializer)

    def test_accepts_portable_nested_relative_location(self) -> None:
        initializer = self._external_initializer("weights/chunk-0001.bin")

        self.assertEqual(
            _external_range(initializer),
            ("weights/chunk-0001.bin", 0, 16),
        )


if __name__ == "__main__":
    unittest.main()
