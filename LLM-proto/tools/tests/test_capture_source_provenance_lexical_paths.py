from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_source_provenance as provenance  # noqa: E402


class CaptureSourceProvenanceLexicalPathTest(unittest.TestCase):
    SHA256 = "a" * 64

    def _entry(self, location: str) -> dict[str, object]:
        return {
            "location": location,
            "bytes": 17,
            "sha256": self.SHA256,
        }

    def test_dot_prefixed_alias_is_rejected_before_identity_aggregation(self) -> None:
        entries = [self._entry("weights.bin"), self._entry("./weights.bin")]

        with self.assertRaisesRegex(ValueError, r"unsafe .*location"):
            provenance._source_external_identity(entries, field="source.externalData")

    def test_nested_dot_segment_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, r"unsafe .*location"):
            provenance._source_external_identity(
                [self._entry("dir/./weights.bin")],
                field="source.externalData",
            )

    def test_windows_separator_dot_segment_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, r"unsafe .*location"):
            provenance._source_external_identity(
                [self._entry(r"dir\.\weights.bin")],
                field="source.externalData",
            )

    def test_normal_nested_relative_location_is_preserved(self) -> None:
        identity = provenance._source_external_identity(
            [self._entry("dir/weights.bin")],
            field="source.externalData",
        )

        self.assertEqual(identity, {"dir/weights.bin": (17, self.SHA256)})


if __name__ == "__main__":
    unittest.main()
