from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import audit_multi_segment_capture as audit_module  # noqa: E402


class AuditMultiSegmentCaptureTest(unittest.TestCase):
    @staticmethod
    def _bundle(**overrides: object) -> dict[str, object]:
        value: dict[str, object] = {
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
        }
        value.update(overrides)
        return value

    @staticmethod
    def _source(**overrides: object) -> dict[str, object]:
        value: dict[str, object] = {
            "status": "pass",
            "captureStatus": "pass",
            "manifestSha256": "a" * 64,
            "sourceGraphSha256": "b" * 64,
            "sourceGraphBytes": 1234,
            "sourceExternalDataCount": 1,
            "sourceExternalDataBytes": 5678,
            "sourceExternalData": [
                {"location": "model.onnx_data", "bytes": 5678, "sha256": "f" * 64}
            ],
        }
        value.update(overrides)
        return value

    def test_happy_path_combines_both_audits(self) -> None:
        calls: list[tuple[str, Path, Path | None]] = []

        def bundle(capture: Path) -> dict[str, object]:
            calls.append(("bundle", capture, None))
            return self._bundle()

        def source(capture: Path, full_model: Path) -> dict[str, object]:
            calls.append(("source", capture, full_model))
            return self._source()

        report = audit_module.audit_capture(
            Path("capture"),
            Path("model.onnx"),
            bundle_verifier=bundle,
            source_verifier=source,
        )

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["captureStatus"], "pass")
        self.assertEqual(report["manifestSha256"], "a" * 64)
        self.assertEqual(report["sourceGraphSha256"], "b" * 64)
        self.assertEqual(report["segmentCount"], 6)
        self.assertEqual([item[0] for item in calls], ["bundle", "source"])

    def test_bundle_failure_stops_before_source_audit(self) -> None:
        source_called = False

        def source(_capture: Path, _full_model: Path) -> dict[str, object]:
            nonlocal source_called
            source_called = True
            return self._source()

        with self.assertRaisesRegex(RuntimeError, "bundle verification did not pass"):
            audit_module.audit_capture(
                Path("capture"),
                Path("model.onnx"),
                bundle_verifier=lambda _capture: self._bundle(status="fail"),
                source_verifier=source,
            )

        self.assertFalse(source_called)

    def test_source_failure_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "source verification did not pass"):
            audit_module.audit_capture(
                Path("capture"),
                Path("model.onnx"),
                bundle_verifier=lambda _capture: self._bundle(),
                source_verifier=lambda _capture, _full_model: self._source(status="fail"),
            )

    def test_manifest_drift_between_audits_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "manifest SHA-256 changed during complete audit"):
            audit_module.audit_capture(
                Path("capture"),
                Path("model.onnx"),
                bundle_verifier=lambda _capture: self._bundle(),
                source_verifier=lambda _capture, _full_model: self._source(
                    manifestSha256="9" * 64
                ),
            )

    def test_source_graph_drift_between_audits_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "source graph SHA-256 changed during complete audit"):
            audit_module.audit_capture(
                Path("capture"),
                Path("model.onnx"),
                bundle_verifier=lambda _capture: self._bundle(),
                source_verifier=lambda _capture, _full_model: self._source(
                    sourceGraphSha256="8" * 64
                ),
            )

    def test_capture_status_drift_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "capture status changed during complete audit"):
            audit_module.audit_capture(
                Path("capture"),
                Path("model.onnx"),
                bundle_verifier=lambda _capture: self._bundle(captureStatus="fail"),
                source_verifier=lambda _capture, _full_model: self._source(captureStatus="pass"),
            )

    def test_noncanonical_digest_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "bundle.manifestSha256 must be a canonical"):
            audit_module.audit_capture(
                Path("capture"),
                Path("model.onnx"),
                bundle_verifier=lambda _capture: self._bundle(manifestSha256="A" * 64),
                source_verifier=lambda _capture, _full_model: self._source(),
            )


if __name__ == "__main__":
    unittest.main()
