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
        self.assertEqual(
            report["bundleVerificationKind"],
            "unzen-budgeted-multi-segment-capture-bundle-verification",
        )
        self.assertEqual(report["bundleVerificationSchemaVersion"], "1.1.0")
        self.assertEqual(
            report["sourceVerificationKind"],
            "unzen-budgeted-multi-segment-capture-source-verification",
        )
        self.assertEqual(report["sourceVerificationSchemaVersion"], "1.0.0")
        self.assertEqual(report["manifestSha256"], "a" * 64)
        self.assertEqual(
            report["captureSnapshotPathResolutionMode"],
            "component-anchored-dirfd",
        )
        self.assertEqual(
            report["auditSnapshotPathResolutionMode"],
            "component-anchored-dirfd",
        )
        self.assertEqual(report["sourceGraphSha256"], "b" * 64)
        self.assertEqual(report["sourcePathResolutionMode"], "component-anchored-dirfd")
        self.assertEqual(report["segmentCount"], 6)
        self.assertEqual([item[0] for item in calls], ["bundle", "source"])

    def test_bundle_contract_drift_is_rejected_before_status(self) -> None:
        cases = (
            ({"kind": None}, "bundle.kind must be"),
            ({"kind": "other"}, "bundle.kind must be"),
            ({"schemaVersion": None}, "bundle.schemaVersion must be"),
            ({"schemaVersion": "2.0.0"}, "bundle.schemaVersion must be"),
        )
        for overrides, message in cases:
            with self.subTest(overrides=overrides):
                bundle = self._bundle(status="fail", **overrides)
                with self.assertRaisesRegex(ValueError, message):
                    audit_module.audit_capture(
                        Path("capture"),
                        Path("model.onnx"),
                        bundle_verifier=lambda _capture, value=bundle: value,
                        source_verifier=lambda _capture, _full_model: self._source(),
                    )

    def test_source_contract_drift_is_rejected_before_status(self) -> None:
        cases = (
            ({"kind": None}, "source.kind must be"),
            ({"kind": "other"}, "source.kind must be"),
            ({"schemaVersion": None}, "source.schemaVersion must be"),
            ({"schemaVersion": "2.0.0"}, "source.schemaVersion must be"),
        )
        for overrides, message in cases:
            with self.subTest(overrides=overrides):
                source = self._source(status="fail", **overrides)
                with self.assertRaisesRegex(ValueError, message):
                    audit_module.audit_capture(
                        Path("capture"),
                        Path("model.onnx"),
                        bundle_verifier=lambda _capture: self._bundle(),
                        source_verifier=lambda _capture, _full_model, value=source: value,
                    )

    def test_legacy_capture_snapshot_mode_is_preserved_as_unknown(self) -> None:
        report = audit_module.audit_capture(
            Path("capture"),
            Path("model.onnx"),
            bundle_verifier=lambda _capture: self._bundle(
                captureSnapshotPathResolutionMode=None
            ),
            source_verifier=lambda _capture, _full_model: self._source(),
        )

        self.assertIsNone(report["captureSnapshotPathResolutionMode"])
        self.assertEqual(
            report["auditSnapshotPathResolutionMode"],
            "component-anchored-dirfd",
        )

    def test_missing_capture_snapshot_mode_contract_is_rejected(self) -> None:
        bundle = self._bundle()
        del bundle["captureSnapshotPathResolutionMode"]

        with self.assertRaisesRegex(
            ValueError,
            "bundle.captureSnapshotPathResolutionMode must be present",
        ):
            audit_module.audit_capture(
                Path("capture"),
                Path("model.onnx"),
                bundle_verifier=lambda _capture: bundle,
                source_verifier=lambda _capture, _full_model: self._source(),
            )

    def test_portable_artifact_audit_mode_is_reported_by_default(self) -> None:
        report = audit_module.audit_capture(
            Path("capture"),
            Path("model.onnx"),
            bundle_verifier=lambda _capture: self._bundle(
                auditSnapshotPathResolutionMode="final-component-only"
            ),
            source_verifier=lambda _capture, _full_model: self._source(),
        )

        self.assertEqual(
            report["auditSnapshotPathResolutionMode"],
            "final-component-only",
        )

    def test_component_anchored_artifact_requirement_rejects_portable_fallback(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            "artifact snapshot verification did not use component-anchored-dirfd path resolution",
        ):
            audit_module.audit_capture(
                Path("capture"),
                Path("model.onnx"),
                require_component_anchored_artifacts=True,
                bundle_verifier=lambda _capture: self._bundle(
                    auditSnapshotPathResolutionMode="final-component-only"
                ),
                source_verifier=lambda _capture, _full_model: self._source(),
            )

    def test_component_anchored_artifact_requirement_accepts_strong_mode(self) -> None:
        report = audit_module.audit_capture(
            Path("capture"),
            Path("model.onnx"),
            require_component_anchored_artifacts=True,
            bundle_verifier=lambda _capture: self._bundle(),
            source_verifier=lambda _capture, _full_model: self._source(
                sourcePathResolutionMode="final-component-only"
            ),
        )

        self.assertEqual(
            report["auditSnapshotPathResolutionMode"],
            "component-anchored-dirfd",
        )
        self.assertEqual(report["sourcePathResolutionMode"], "final-component-only")

    def test_unknown_or_missing_artifact_audit_mode_is_rejected(self) -> None:
        cases = (None, "unknown-mode")
        for audit_mode in cases:
            with self.subTest(audit_mode=audit_mode):
                with self.assertRaisesRegex(
                    ValueError,
                    "bundle.auditSnapshotPathResolutionMode must be one of",
                ):
                    audit_module.audit_capture(
                        Path("capture"),
                        Path("model.onnx"),
                        bundle_verifier=lambda _capture, mode=audit_mode: self._bundle(
                            auditSnapshotPathResolutionMode=mode
                        ),
                        source_verifier=lambda _capture, _full_model: self._source(),
                    )

    def test_unknown_capture_snapshot_mode_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "bundle.captureSnapshotPathResolutionMode must be one of",
        ):
            audit_module.audit_capture(
                Path("capture"),
                Path("model.onnx"),
                bundle_verifier=lambda _capture: self._bundle(
                    captureSnapshotPathResolutionMode="unknown-mode"
                ),
                source_verifier=lambda _capture, _full_model: self._source(),
            )

    def test_portable_source_mode_is_reported_by_default(self) -> None:
        report = audit_module.audit_capture(
            Path("capture"),
            Path("model.onnx"),
            bundle_verifier=lambda _capture: self._bundle(),
            source_verifier=lambda _capture, _full_model: self._source(
                sourcePathResolutionMode="final-component-only"
            ),
        )

        self.assertEqual(report["sourcePathResolutionMode"], "final-component-only")

    def test_component_anchored_requirement_rejects_portable_fallback(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            "source verification did not use component-anchored-dirfd path resolution",
        ):
            audit_module.audit_capture(
                Path("capture"),
                Path("model.onnx"),
                require_component_anchored_source=True,
                bundle_verifier=lambda _capture: self._bundle(),
                source_verifier=lambda _capture, _full_model: self._source(
                    sourcePathResolutionMode="final-component-only"
                ),
            )

    def test_component_anchored_requirement_accepts_strong_mode(self) -> None:
        report = audit_module.audit_capture(
            Path("capture"),
            Path("model.onnx"),
            require_component_anchored_source=True,
            bundle_verifier=lambda _capture: self._bundle(
                auditSnapshotPathResolutionMode="final-component-only"
            ),
            source_verifier=lambda _capture, _full_model: self._source(),
        )

        self.assertEqual(report["sourcePathResolutionMode"], "component-anchored-dirfd")
        self.assertEqual(
            report["auditSnapshotPathResolutionMode"],
            "final-component-only",
        )

    def test_unknown_or_missing_source_mode_is_rejected(self) -> None:
        cases = (None, "unknown-mode")
        for source_mode in cases:
            with self.subTest(source_mode=source_mode):
                with self.assertRaisesRegex(
                    ValueError,
                    "source.sourcePathResolutionMode must be one of",
                ):
                    audit_module.audit_capture(
                        Path("capture"),
                        Path("model.onnx"),
                        bundle_verifier=lambda _capture: self._bundle(),
                        source_verifier=lambda _capture, _full_model, mode=source_mode: self._source(
                            sourcePathResolutionMode=mode
                        ),
                    )

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

    def test_control_file_snapshot_drift_between_audits_is_rejected(self) -> None:
        cases = (
            ("runSummarySha256", "run-summary SHA-256", "7" * 64),
            ("evidenceSha256", "evidence SHA-256", "6" * 64),
            ("verificationSha256", "verification SHA-256", "5" * 64),
        )
        for key, label, changed_digest in cases:
            with self.subTest(key=key):
                def source(
                    _capture: Path,
                    _full_model: Path,
                    changed_key: str = key,
                    digest: str = changed_digest,
                ) -> dict[str, object]:
                    return self._source(**{changed_key: digest})

                with self.assertRaisesRegex(
                    RuntimeError,
                    f"{label} changed during complete audit",
                ):
                    audit_module.audit_capture(
                        Path("capture"),
                        Path("model.onnx"),
                        bundle_verifier=lambda _capture: self._bundle(),
                        source_verifier=source,
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
