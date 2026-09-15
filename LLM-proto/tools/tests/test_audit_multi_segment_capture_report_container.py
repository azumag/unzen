from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import audit_multi_segment_capture as audit_module  # noqa: E402


class AuditMultiSegmentCaptureReportContainerTest(unittest.TestCase):
    @staticmethod
    def _bundle() -> dict[str, object]:
        return {
            "schemaVersion": "1.1.0",
            "kind": "unzen-budgeted-multi-segment-capture-bundle-verification",
            "status": "pass",
            "captureStatus": "pass",
            "manifestSha256": "a" * 64,
            "sourceGraphSha256": "b" * 64,
            "segmentCount": 6,
            "maximumSegmentArtifactBytes": 200 * 1024 * 1024,
            "effectiveRequiredMaxBytes": 256 * 1024 * 1024,
            "runSummarySha256": "c" * 64,
            "evidenceSha256": "d" * 64,
            "verificationSha256": "e" * 64,
            "captureSnapshotPathResolutionMode": "component-anchored-dirfd",
            "auditSnapshotPathResolutionMode": "component-anchored-dirfd",
        }

    @staticmethod
    def _source() -> dict[str, object]:
        return {
            "schemaVersion": "1.0.0",
            "kind": "unzen-budgeted-multi-segment-capture-source-verification",
            "status": "pass",
            "captureStatus": "pass",
            "manifestSha256": "a" * 64,
            "runSummarySha256": "c" * 64,
            "evidenceSha256": "d" * 64,
            "verificationSha256": "e" * 64,
            "sourceGraphSha256": "b" * 64,
            "sourcePathResolutionMode": "component-anchored-dirfd",
            "sourceGraphBytes": 1234,
            "sourceExternalDataCount": 1,
            "sourceExternalDataBytes": 10,
            "sourceExternalData": [
                {"location": "weights/a.bin", "bytes": 10, "sha256": "f" * 64},
            ],
        }

    def _audit(
        self,
        *,
        bundles: list[object],
        sources: list[object],
    ) -> dict[str, object]:
        bundle_reports = iter(bundles)
        source_reports = iter(sources)
        return audit_module.audit_capture(
            Path("capture"),
            Path("model.onnx"),
            bundle_verifier=lambda _capture: next(bundle_reports),
            source_verifier=lambda _capture, _full_model: next(source_reports),
        )

    def test_initial_bundle_must_be_an_object(self) -> None:
        with self.assertRaisesRegex(ValueError, "^bundle must be an object$"):
            self._audit(bundles=[None], sources=[])

    def test_source_report_must_be_an_object(self) -> None:
        with self.assertRaisesRegex(ValueError, "^source must be an object$"):
            self._audit(bundles=[self._bundle()], sources=[["not", "an", "object"]])

    def test_post_source_bundle_must_be_an_object(self) -> None:
        with self.assertRaisesRegex(ValueError, "^post-source bundle must be an object$"):
            self._audit(
                bundles=[self._bundle(), "not-an-object"],
                sources=[self._source()],
            )

    def test_post_bundle_source_must_be_an_object(self) -> None:
        with self.assertRaisesRegex(ValueError, "^post-bundle source must be an object$"):
            self._audit(
                bundles=[self._bundle(), self._bundle()],
                sources=[self._source(), 7],
            )

    def test_valid_report_objects_preserve_existing_contract(self) -> None:
        report = self._audit(
            bundles=[self._bundle(), self._bundle()],
            sources=[self._source(), self._source()],
        )

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["captureStatus"], "pass")
        self.assertEqual(report["manifestSha256"], "a" * 64)
        self.assertEqual(report["sourceGraphSha256"], "b" * 64)


if __name__ == "__main__":
    unittest.main()
