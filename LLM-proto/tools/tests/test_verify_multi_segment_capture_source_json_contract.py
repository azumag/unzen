from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_source as source_module  # noqa: E402


DIGEST = "a" * 64


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
            "sha256": DIGEST,
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

    def test_exact_duplicate_external_location_keeps_existing_error(self) -> None:
        entry = {
            "location": "weights/chunk.bin",
            "bytes": 16,
            "sha256": DIGEST,
        }
        with self.assertRaisesRegex(
            ValueError,
            r"duplicate external-data location in sourceModel\.externalData: weights/chunk\.bin",
        ):
            source_module._normalized_external_entries(
                [entry, dict(entry)],
                field="sourceModel.externalData",
            )

    def test_ascii_case_only_external_location_alias_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            r"portable case alias external-data location in sourceModel\.externalData: "
            r"weights/chunk\.bin aliases weights/Chunk\.bin",
        ):
            source_module._normalized_external_entries(
                [
                    {"location": "weights/Chunk.bin", "bytes": 16, "sha256": DIGEST},
                    {"location": "weights/chunk.bin", "bytes": 32, "sha256": "b" * 64},
                ],
                field="sourceModel.externalData",
            )

    def test_distinct_external_locations_remain_accepted(self) -> None:
        normalized = source_module._normalized_external_entries(
            [
                {"location": "weights/chunk-a.bin", "bytes": 16, "sha256": DIGEST},
                {"location": "weights/chunk-b.bin", "bytes": 32, "sha256": "b" * 64},
            ],
            field="sourceModel.externalData",
        )
        self.assertEqual(
            [entry["location"] for entry in normalized],
            ["weights/chunk-a.bin", "weights/chunk-b.bin"],
        )

    def test_manifest_case_alias_rejects_before_source_filesystem_access(self) -> None:
        summary = {
            "artifacts": {"manifest": "split-manifest.json"},
            "evidence": {"path": "evidence.json"},
        }
        manifest = {
            "sourceModel": {
                "sha256": DIGEST,
                "externalData": [
                    {"location": "weights/Chunk.bin", "bytes": 16, "sha256": DIGEST},
                    {"location": "weights/chunk.bin", "bytes": 16, "sha256": "b" * 64},
                ],
            }
        }
        bundle = {
            "status": "pass",
            "runSummarySha256": DIGEST,
            "manifestSha256": DIGEST,
            "evidenceSha256": DIGEST,
            "verificationSha256": DIGEST,
        }

        with (
            patch.object(source_module, "verify_capture_bundle", return_value=bundle),
            patch.object(
                source_module,
                "_stable_json_object",
                side_effect=[(summary, DIGEST), (manifest, DIGEST)],
            ),
            patch.object(source_module, "_open_directory_anchor") as open_root,
            patch.object(source_module, "_preflight_source_file_identities") as preflight_files,
        ):
            with self.assertRaisesRegex(ValueError, "portable case alias external-data location"):
                source_module.verify_capture_source(Path("capture"), Path("model.onnx"))

        open_root.assert_not_called()
        preflight_files.assert_not_called()

    def test_graph_bytes_uses_the_same_strict_integer_contract(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "graphBytes must be a non-negative integer",
        ):
            source_module._non_negative_int(1024.5, field="graphBytes")


if __name__ == "__main__":
    unittest.main()