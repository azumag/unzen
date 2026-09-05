from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_bundle as bundle_module  # noqa: E402
import verify_multi_segment_capture_source as source_module  # noqa: E402


class VerifyMultiSegmentCaptureStringContractTest(unittest.TestCase):
    def test_bundle_sha256_rejects_numeric_json_value(self) -> None:
        numeric_digest = int("1" * 64)
        with self.assertRaisesRegex(ValueError, "must be a non-empty string"):
            bundle_module._canonical_sha256(
                numeric_digest,
                field="run-summary.evidence.sha256",
            )

    def test_bundle_relative_path_rejects_numeric_json_value(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            with self.assertRaisesRegex(ValueError, "must be a non-empty string"):
                bundle_module._safe_relative_path(
                    Path(raw_dir),
                    123,
                    field="run-summary.evidence.path",
                )

    def test_source_sha256_rejects_numeric_json_value(self) -> None:
        numeric_digest = int("2" * 64)
        with self.assertRaisesRegex(ValueError, "must be a non-empty string"):
            source_module._canonical_sha256(
                numeric_digest,
                field="split-manifest.sourceModel.sha256",
            )

    def test_source_relative_path_rejects_boolean_json_value(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            with self.assertRaisesRegex(ValueError, "must be a non-empty string"):
                source_module._safe_relative_path(
                    Path(raw_dir),
                    True,
                    field="run-summary.artifacts.manifest",
                )

    def test_source_external_location_rejects_numeric_json_value(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            r"sourceModel.externalData\[0\]\.location must be a non-empty string",
        ):
            source_module._normalized_external_entries(
                [
                    {
                        "location": 123,
                        "bytes": 0,
                        "sha256": "a" * 64,
                    }
                ],
                field="sourceModel.externalData",
            )


if __name__ == "__main__":
    unittest.main()
