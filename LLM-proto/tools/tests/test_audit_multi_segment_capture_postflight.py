from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import audit_multi_segment_capture as audit_module  # noqa: E402


class AuditMultiSegmentCapturePostflightTest(unittest.TestCase):
    @staticmethod
    def _bundle(**overrides: object) -> dict[str, object]:
        value: dict[str, object] = {
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
        value.update(overrides)
        return value

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
            "sourceExternalDataBytes": 5678,
            "sourceExternalData": [
                {"location": "model.onnx_data", "bytes": 5678, "sha256": "f" * 64}
            ],
        }

    def _run_with_final_bundle(self, final_bundle: dict[str, object]) -> dict[str, object]:
        calls = 0

        def bundle(_capture: Path) -> dict[str, object]:
            nonlocal calls
            calls += 1
            return self._bundle() if calls == 1 else final_bundle

        return audit_module.audit_capture(
            Path("capture"),
            Path("model.onnx"),
            bundle_verifier=bundle,
            source_verifier=lambda _capture, _full_model: self._source(),
        )

    def test_postflight_control_digest_drift_is_rejected(self) -> None:
        for key, label in (
            ("runSummarySha256", "run-summary SHA-256 after source audit"),
            ("manifestSha256", "manifest SHA-256 after source audit"),
            ("evidenceSha256", "evidence SHA-256 after source audit"),
            ("verificationSha256", "verification SHA-256 after source audit"),
        ):
            with self.subTest(key=key):
                final_bundle = self._bundle(**{key: "9" * 64})
                with self.assertRaisesRegex(RuntimeError, label):
                    self._run_with_final_bundle(final_bundle)

    def test_postflight_security_metadata_drift_is_rejected(self) -> None:
        cases = (
            ({"captureStatus": "fail"}, "capture status after source audit"),
            ({"sourceGraphSha256": "9" * 64}, "source graph SHA-256 after source audit"),
            ({"segmentCount": 7}, "segment count after source audit"),
            (
                {"maximumSegmentArtifactBytes": 201 * 1024 * 1024},
                "maximum segment artifact bytes after source audit",
            ),
            (
                {"effectiveRequiredMaxBytes": 512 * 1024 * 1024},
                "effective required max bytes after source audit",
            ),
            (
                {"captureSnapshotPathResolutionMode": "final-component-only"},
                "capture snapshot path-resolution mode after source audit",
            ),
            (
                {"auditSnapshotPathResolutionMode": "final-component-only"},
                "artifact audit path-resolution mode after source audit",
            ),
        )
        for overrides, label in cases:
            with self.subTest(overrides=overrides):
                with self.assertRaisesRegex(RuntimeError, label):
                    self._run_with_final_bundle(self._bundle(**overrides))

    def test_postflight_contract_is_revalidated_before_status(self) -> None:
        with self.assertRaisesRegex(ValueError, "post-source bundle.kind must be"):
            self._run_with_final_bundle(self._bundle(kind="other", status="fail"))

    def test_postflight_failure_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "post-source bundle verification did not pass"):
            self._run_with_final_bundle(self._bundle(status="fail"))

    def test_strict_artifact_mode_is_rechecked_postflight(self) -> None:
        calls = 0

        def bundle(_capture: Path) -> dict[str, object]:
            nonlocal calls
            calls += 1
            if calls == 1:
                return self._bundle()
            return self._bundle(auditSnapshotPathResolutionMode="final-component-only")

        with self.assertRaisesRegex(
            RuntimeError,
            "post-source artifact snapshot verification did not use component-anchored-dirfd",
        ):
            audit_module.audit_capture(
                Path("capture"),
                Path("model.onnx"),
                require_component_anchored_artifacts=True,
                bundle_verifier=bundle,
                source_verifier=lambda _capture, _full_model: self._source(),
            )


if __name__ == "__main__":
    unittest.main()
