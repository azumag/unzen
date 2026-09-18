from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import capture_multi_segment_evidence_run as capture_module  # noqa: E402


class CaptureIntegrityReportContractTest(unittest.TestCase):
    MANIFEST_SHA256 = "a" * 64

    @classmethod
    def _integrity(cls) -> dict[str, object]:
        return {
            "status": "pass",
            "manifestSha256": cls.MANIFEST_SHA256,
            "segmentCount": 2,
            "maximumSegmentArtifactBytes": 123,
            "effectiveRequiredMaxBytes": 456,
        }

    @classmethod
    def _snapshot(cls, integrity: dict[str, object]) -> dict[str, object]:
        return {
            "schemaVersion": capture_module.SNAPSHOT_REPORT_SCHEMA_VERSION,
            "kind": capture_module.SNAPSHOT_REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "pathResolutionMode": capture_module.PATH_RESOLUTION_COMPONENT_ANCHORED,
            "manifestSha256": integrity["manifestSha256"],
            "segmentCount": integrity["segmentCount"],
            "artifactFileCount": 1,
            "artifacts": [{"path": "segment0.onnx"}],
            "integrity": integrity,
        }

    @staticmethod
    def _evidence(artifact_integrity: dict[str, object]) -> dict[str, object]:
        return {
            "status": "pass",
            "verificationSha256": "c" * 64,
            "verification": {
                "status": "pass",
                "artifactIntegrity": artifact_integrity,
            },
        }

    def test_valid_positive_integer_metadata_is_accepted(self) -> None:
        report = self._integrity()
        self.assertIs(capture_module._require_integrity_pass(report), report)

    def test_boolean_count_and_byte_metadata_is_rejected(self) -> None:
        for field in (
            "segmentCount",
            "maximumSegmentArtifactBytes",
            "effectiveRequiredMaxBytes",
        ):
            for value in (True, False):
                with self.subTest(field=field, value=value):
                    report = self._integrity()
                    report[field] = value
                    with self.assertRaisesRegex(ValueError, f"invalid {field}"):
                        capture_module._require_integrity_pass(report)

    def test_embedded_boolean_segment_count_is_rejected_even_when_equal_to_one(self) -> None:
        preflight = self._integrity()
        preflight["segmentCount"] = 1
        embedded = dict(preflight)
        embedded["segmentCount"] = True

        with self.assertRaisesRegex(ValueError, "invalid segmentCount"):
            capture_module._require_evidence_matches_preflight(
                self._evidence(embedded),
                preflight,
            )

    def test_malformed_integrity_report_stops_capture_before_numerical_work(self) -> None:
        malformed = self._integrity()
        malformed["maximumSegmentArtifactBytes"] = True

        with tempfile.TemporaryDirectory() as raw_dir:
            destination = Path(raw_dir) / "capture"
            with (
                patch.object(capture_module, "ensure_provider_available"),
                patch.object(capture_module, "sha256_file", return_value="b" * 64),
                patch.object(capture_module, "prepare_budgeted_multi_split"),
                patch.object(
                    capture_module,
                    "_require_source_graph_snapshot",
                    return_value=self.MANIFEST_SHA256,
                ),
                patch.object(
                    capture_module,
                    "verify_artifact_snapshot",
                    return_value=self._snapshot(malformed),
                ),
                patch.object(capture_module, "collect_evidence") as collect,
                patch.object(capture_module, "write_evidence") as write,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "invalid maximumSegmentArtifactBytes",
                ):
                    capture_module.capture_run(
                        Path(raw_dir) / "model_q4.onnx",
                        destination,
                        [1],
                    )

            collect.assert_not_called()
            write.assert_not_called()
            self.assertFalse(destination.exists())

    def test_malformed_embedded_integrity_stops_publication_after_numerical_work(self) -> None:
        preflight = self._integrity()
        preflight["segmentCount"] = 1
        embedded = dict(preflight)
        embedded["segmentCount"] = True

        with tempfile.TemporaryDirectory() as raw_dir:
            destination = Path(raw_dir) / "capture"
            with (
                patch.object(capture_module, "ensure_provider_available"),
                patch.object(capture_module, "sha256_file", return_value="b" * 64),
                patch.object(capture_module, "prepare_budgeted_multi_split"),
                patch.object(
                    capture_module,
                    "_require_source_graph_snapshot",
                    return_value=self.MANIFEST_SHA256,
                ),
                patch.object(
                    capture_module,
                    "verify_artifact_snapshot",
                    return_value=self._snapshot(preflight),
                ),
                patch.object(
                    capture_module,
                    "collect_evidence",
                    return_value=self._evidence(embedded),
                ) as collect,
                patch.object(capture_module, "write_evidence") as write,
            ):
                with self.assertRaisesRegex(ValueError, "invalid segmentCount"):
                    capture_module.capture_run(
                        Path(raw_dir) / "model_q4.onnx",
                        destination,
                        [1],
                    )

            collect.assert_called_once()
            write.assert_not_called()
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
