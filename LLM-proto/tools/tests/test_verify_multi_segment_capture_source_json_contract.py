from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_source as source_module  # noqa: E402


class VerifyMultiSegmentCaptureSourceJsonContractTest(unittest.TestCase):
    def test_non_negative_integer_accepts_only_json_integers(self) -> None:
        self.assertEqual(
            source_module._non_negative_int(0, field="bytes"),
            0,
        )
        self.assertEqual(
            source_module._non_negative_int(42, field="bytes"),
            42,
        )

        for malformed in (True, False, 12.0, 12.9, "12", None):
            with self.subTest(malformed=malformed):
                with self.assertRaisesRegex(
                    ValueError,
                    "bytes must be a non-negative integer",
                ):
                    source_module._non_negative_int(malformed, field="bytes")

    def test_external_data_bytes_do_not_silently_coerce_float_or_string(self) -> None:
        base_entry = {
            "location": "model_q4.onnx_data",
            "sha256": "a" * 64,
        }
        for malformed in (16.0, 16.75, "16"):
            with self.subTest(malformed=malformed):
                entry = {**base_entry, "bytes": malformed}
                with self.assertRaisesRegex(
                    ValueError,
                    r"sourceModel\.externalData\[0\]\.bytes must be a non-negative integer",
                ):
                    source_module._normalized_external_entries(
                        [entry],
                        field="sourceModel.externalData",
                    )

    def test_graph_bytes_uses_the_same_strict_integer_contract(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "graphBytes must be a non-negative integer",
        ):
            source_module._non_negative_int(1024.5, field="graphBytes")


if __name__ == "__main__":
    unittest.main()
