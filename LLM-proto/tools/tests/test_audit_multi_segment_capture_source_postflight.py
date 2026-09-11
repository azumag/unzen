from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import audit_multi_segment_capture as audit_module  # noqa: E402


class AuditMultiSegmentCaptureSourcePostflightTest(unittest.TestCase):
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
    def _source(**overrides: object) -> dict[str, object]:
        value: dict[str, object] = {
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
        value.update(overrides)
        return value

    def _run_with_postflight_source(
        self,
        postflight_source: dict[str, object],
        *,
        require_component_anchored_source: bool = False,
    ) -> dict[str, object]:
        source_calls = 0

        def source(_capture: Path, _full_model: Path) -> dict[str, object]:
            nonlocal source_calls
            source_calls += 1
            return self._source() if source_calls == 1 else deepcopy(postflight_source)

        return audit_module.audit_capture(
            Path("capture"),
            Path("model.onnx"),
            require_component_anchored_source=require_component_anchored_source,
            bundle_verifier=lambda _capture: self._bundle(),
            source_verifier=source,
        )

    def test_source_verifier_is_rechecked_after_bundle_postflight(self) -> None:
        source_calls = 0
        bundle_calls = 0

        def source(_capture: Path, _full_model: Path) -> dict[str, object]:
            nonlocal source_calls
            source_calls += 1
            return self._source()

        def bundle(_capture: Path) -> dict[str, object]:
            nonlocal bundle_calls
            bundle_calls += 1
            return self._bundle()

        report = audit_module.audit_capture(
            Path("capture"),
            Path("model.onnx"),
            bundle_verifier=bundle,
            source_verifier=source,
        )

        self.assertEqual(report["status"], "pass")
        self.assertEqual(bundle_calls, 2)
        self.assertEqual(source_calls, 2)

    def test_postflight_source_control_digest_drift_is_rejected(self) -> None:
        for key, label in (
            ("runSummarySha256", "run-summary SHA-256 after bundle postflight"),
            ("manifestSha256", "manifest SHA-256 after bundle postflight"),
            ("evidenceSha256", "evidence SHA-256 after bundle postflight"),
            ("verificationSha256", "verification SHA-256 after bundle postflight"),
        ):
            with self.subTest(key=key):
                with self.assertRaisesRegex(RuntimeError, label):
                    self._run_with_postflight_source(self._source(**{key: "9" * 64}))

    def test_postflight_source_artifact_drift_is_rejected(self) -> None:
        changed_external = [
            {"location": "model.onnx_data", "bytes": 5678, "sha256": "9" * 64}
        ]
        cases = (
            ({"sourceGraphSha256": "9" * 64}, "source graph SHA-256 after bundle postflight"),
            ({"sourceGraphBytes": 1235}, "source graph bytes after bundle postflight"),
            ({"sourceExternalData": changed_external}, "source external data after bundle postflight"),
            ({"sourceExternalDataCount": 2}, "sourceExternalDataCount must equal"),
            ({"sourceExternalDataBytes": 5679}, "sourceExternalDataBytes must equal"),
            ({"captureStatus": "fail"}, "capture status after bundle postflight"),
            (
                {"sourcePathResolutionMode": "final-component-only"},
                "source path-resolution mode after bundle postflight",
            ),
        )
        for overrides, label in cases:
            with self.subTest(overrides=overrides):
                with self.assertRaisesRegex((RuntimeError, ValueError), label):
                    self._run_with_postflight_source(self._source(**overrides))

    def test_postflight_source_contract_is_revalidated_before_status(self) -> None:
        with self.assertRaisesRegex(ValueError, "post-bundle source.kind must be"):
            self._run_with_postflight_source(self._source(kind="other", status="fail"))

    def test_postflight_source_failure_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            "post-bundle source verification did not pass",
        ):
            self._run_with_postflight_source(self._source(status="fail"))

    def test_strict_source_mode_is_rechecked_postflight(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            "post-bundle source verification did not use component-anchored-dirfd",
        ):
            self._run_with_postflight_source(
                self._source(sourcePathResolutionMode="final-component-only"),
                require_component_anchored_source=True,
            )


if __name__ == "__main__":
    unittest.main()
