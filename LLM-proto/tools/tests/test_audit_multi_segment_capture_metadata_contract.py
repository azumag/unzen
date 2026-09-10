from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import audit_multi_segment_capture as audit_module  # noqa: E402


class AuditMultiSegmentCaptureMetadataContractTest(unittest.TestCase):
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
            "sourceExternalDataCount": 2,
            "sourceExternalDataBytes": 30,
            "sourceExternalData": [
                {"location": "weights/a.bin", "bytes": 10, "sha256": "f" * 64},
                {"location": "weights/b.bin", "bytes": 20, "sha256": "1" * 64},
            ],
        }
        value.update(overrides)
        return value

    def _audit(
        self,
        *,
        bundle: dict[str, object] | None = None,
        source: dict[str, object] | None = None,
    ) -> dict[str, object]:
        bundle_report = bundle if bundle is not None else self._bundle()
        source_report = source if source is not None else self._source()
        return audit_module.audit_capture(
            Path("capture"),
            Path("model.onnx"),
            bundle_verifier=lambda _capture: bundle_report,
            source_verifier=lambda _capture, _full_model: source_report,
        )

    def test_validated_metadata_is_preserved(self) -> None:
        report = self._audit()

        self.assertEqual(report["captureStatus"], "pass")
        self.assertEqual(report["segmentCount"], 6)
        self.assertEqual(report["sourceGraphBytes"], 1234)
        self.assertEqual(report["sourceExternalDataCount"], 2)
        self.assertEqual(report["sourceExternalDataBytes"], 30)
        self.assertEqual(
            report["sourceExternalData"],
            [
                {"location": "weights/a.bin", "bytes": 10, "sha256": "f" * 64},
                {"location": "weights/b.bin", "bytes": 20, "sha256": "1" * 64},
            ],
        )

    def test_bundle_integer_contract_is_fail_closed(self) -> None:
        cases = (
            ("segmentCount", 0, "bundle.segmentCount must be a positive integer"),
            ("maximumSegmentArtifactBytes", False, "bundle.maximumSegmentArtifactBytes must be a non-negative integer"),
            ("effectiveRequiredMaxBytes", 1.0, "bundle.effectiveRequiredMaxBytes must be a non-negative integer"),
        )
        for field, value, message in cases:
            with self.subTest(field=field, value=value):
                with self.assertRaisesRegex(ValueError, message):
                    self._audit(bundle=self._bundle(**{field: value}))

    def test_source_integer_contract_is_fail_closed(self) -> None:
        cases = (
            ("sourceGraphBytes", -1),
            ("sourceExternalDataCount", False),
            ("sourceExternalDataBytes", 30.0),
        )
        for field, value in cases:
            with self.subTest(field=field, value=value):
                with self.assertRaisesRegex(ValueError, f"source.{field} must be a non-negative integer"):
                    self._audit(source=self._source(**{field: value}))

    def test_source_external_data_aggregates_must_match_entries(self) -> None:
        with self.assertRaisesRegex(ValueError, "source.sourceExternalDataCount must equal"):
            self._audit(source=self._source(sourceExternalDataCount=1))

        with self.assertRaisesRegex(ValueError, "source.sourceExternalDataBytes must equal"):
            self._audit(source=self._source(sourceExternalDataBytes=29))

    def test_source_external_data_entry_contract_is_fail_closed(self) -> None:
        cases = (
            (
                [{"location": "weights/a.bin", "bytes": True, "sha256": "f" * 64}],
                "source.sourceExternalData\\[0\\].bytes must be a non-negative integer",
            ),
            (
                [{"location": "../a.bin", "bytes": 10, "sha256": "f" * 64}],
                "unsafe source.sourceExternalData\\[0\\].location",
            ),
            (
                [{"location": "weights/a.bin", "bytes": 10, "sha256": "F" * 64}],
                "source.sourceExternalData\\[0\\].sha256 must be a canonical lowercase SHA-256 digest",
            ),
            (
                [
                    {"location": "weights/a.bin", "bytes": 10, "sha256": "f" * 64},
                    {"location": "weights/a.bin", "bytes": 20, "sha256": "1" * 64},
                ],
                "duplicate external-data location",
            ),
        )
        for entries, message in cases:
            with self.subTest(message=message):
                total = sum(
                    int(entry.get("bytes", 0))
                    for entry in entries
                    if isinstance(entry.get("bytes"), int) and not isinstance(entry.get("bytes"), bool)
                )
                source = self._source(
                    sourceExternalData=entries,
                    sourceExternalDataCount=len(entries),
                    sourceExternalDataBytes=total,
                )
                with self.assertRaisesRegex(ValueError, message):
                    self._audit(source=source)

    def test_unknown_capture_status_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "bundle.captureStatus must be one of: fail, pass"):
            self._audit(
                bundle=self._bundle(captureStatus="unknown"),
                source=self._source(captureStatus="unknown"),
            )

    def test_numerical_failure_status_remains_auditable(self) -> None:
        report = self._audit(
            bundle=self._bundle(captureStatus="fail"),
            source=self._source(captureStatus="fail"),
        )

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["captureStatus"], "fail")


if __name__ == "__main__":
    unittest.main()
