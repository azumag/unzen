from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import audit_multi_segment_capture as audit_module  # noqa: E402


DIGEST = "0" * 64


def entry(location: str, *, byte_size: int = 1) -> dict[str, object]:
    return {"location": location, "bytes": byte_size, "sha256": DIGEST}


class CompleteAuditSourcePathGrammarTest(unittest.TestCase):
    def test_rejects_noncanonical_location_spelling(self) -> None:
        malformed = (
            "weights//chunk.bin",
            "weights/./chunk.bin",
            "weights/",
            "weights/\nchunk.bin",
            "weights/\x1fchunk.bin",
            "weights/\x7fchunk.bin",
        )
        for location in malformed:
            with self.subTest(location=repr(location)):
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    audit_module._source_external_data(
                        [entry(location)],
                        field="source.sourceExternalData",
                    )

    def test_rejects_portable_case_alias(self) -> None:
        with self.assertRaisesRegex(ValueError, "portable case alias"):
            audit_module._source_external_data(
                [entry("weights/Chunk.bin"), entry("weights/chunk.bin")],
                field="source.sourceExternalData",
            )

    def test_rejects_portable_separator_alias(self) -> None:
        with self.assertRaisesRegex(ValueError, "portable separator alias"):
            audit_module._source_external_data(
                [entry("weights/chunk.bin"), entry(r"weights\chunk.bin")],
                field="source.sourceExternalData",
            )

    def test_accepts_distinct_nested_unicode_locations(self) -> None:
        observed = audit_module._source_external_data(
            [entry("モデル/重み一.bin", byte_size=2), entry("モデル/重み二.bin", byte_size=3)],
            field="source.sourceExternalData",
        )

        self.assertEqual(
            observed,
            [
                entry("モデル/重み一.bin", byte_size=2),
                entry("モデル/重み二.bin", byte_size=3),
            ],
        )


if __name__ == "__main__":
    unittest.main()
