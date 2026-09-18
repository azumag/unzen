from pathlib import Path
import math
import sys
import tempfile
import unittest
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_llama_1b_endpoint_five_way_tile_ort_webgpu as probe


class FiveWayCopyRangePreflightTest(unittest.TestCase):
    def test_rejects_malformed_source_offsets_before_destination_creation_or_read(self) -> None:
        invalid_offsets = (True, False, -1, 1.0, math.nan, math.inf, -math.inf, "0", None, object())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, source_offset in enumerate(invalid_offsets):
                with self.subTest(source_offset=source_offset):
                    destination = root / f"offset-{index}.bin"
                    with mock.patch.object(
                        probe.os,
                        "pread",
                        side_effect=AssertionError("source read must not run"),
                    ) as pread_mock:
                        with self.assertRaisesRegex(ValueError, "source_offset must be a non-negative integer"):
                            probe._copy_source_range(
                                -1,
                                source_offset=source_offset,
                                length=1,
                                destination=destination,
                            )
                    pread_mock.assert_not_called()
                    self.assertFalse(destination.exists())

    def test_rejects_malformed_lengths_before_destination_creation_or_read(self) -> None:
        invalid_lengths = (True, False, 0, -1, 1.0, math.nan, math.inf, -math.inf, "1", None, object())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, length in enumerate(invalid_lengths):
                with self.subTest(length=length):
                    destination = root / f"length-{index}.bin"
                    with mock.patch.object(
                        probe.os,
                        "pread",
                        side_effect=AssertionError("source read must not run"),
                    ) as pread_mock:
                        with self.assertRaisesRegex(ValueError, "length must be a positive integer"):
                            probe._copy_source_range(
                                -1,
                                source_offset=0,
                                length=length,
                                destination=destination,
                            )
                    pread_mock.assert_not_called()
                    self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
