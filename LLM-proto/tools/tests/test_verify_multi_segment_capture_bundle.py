from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_bundle as bundle_module  # noqa: E402


class VerifyMultiSegmentCaptureBundleTest(unittest.TestCase):
    @staticmethod
    def _integrity() -> dict[str, object]:
        return {
            "schemaVersion": "1.0.0",
            "kind": "unzen-budgeted-multi-segment-artifact-integrity",
            "status": "pass",
            "manifestSha256": "a" * 64,
            "segmentCount": 2,
            "maximumSegmentArtifactBytes": 123,
            "effectiveRequiredMaxBytes": 256 * 1024 * 1024,
            "segments": [],
        }

    def _write_bundle(
        self,
        root: Path,
        *,
        evidence_path: str = "same-machine-evidence.json",
        summary_manifest_sha: str = "a" * 64,
    ) -> tuple[Path, dict[str, object], dict[str, object]]:
        capture = root / "capture"
        split = capture / "split"
        split.mkdir(parents=True)
        (split / "split-manifest.json").write_text("{}\n", encoding="utf-8")

        source_sha = "c" * 64
        parameters = {
            "hiddenSize": 2048,
            "targetBytes": 200 * 1024 * 1024,
            "preferredMaxBytes": 256 * 1024 * 1024,
            "provider": "CPUExecutionProvider",
            "inputTokenIds": [11, 22],
            "kvHeads": 8,
            "headSize": 64,
            "atol": 1e-4,
            "rtol": 1e-4,
        }
        verification = {
            "schemaVersion": "1.1.0",
            "kind": "unzen-budgeted-multi-segment-same-machine-verification",
            "status": "pass",
            "provider": "CPUExecutionProvider",
            "inputTokenIds": [11, 22],
            "artifactIntegrity": self._integrity(),
            "sourceModel": {
                "graphSha256": source_sha,
            },
        }
        verification_sha = hashlib.sha256(
            bundle_module.canonical_json_bytes(verification)
        ).hexdigest()
        evidence = {
            "schemaVersion": "1.0.0",
            "kind": "unzen-budgeted-multi-segment-evidence-bundle",
            "status": "pass",
            "parameters": {
                "provider": "CPUExecutionProvider",
                "inputTokenIds": [11, 22],
                "kvHeads": 8,
                "headSize": 64,
                "atol": 1e-4,
                "rtol": 1e-4,
            },
            "verificationSha256": verification_sha,
            "verification": verification,
        }

        evidence_file = capture / evidence_path
        evidence_file.parent.mkdir(parents=True, exist_ok=True)
        evidence_file.write_text(
            json.dumps(evidence, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        evidence_sha = bundle_module.sha256_file(evidence_file)

        summary = {
            "schemaVersion": "1.0.0",
            "kind": "unzen-budgeted-multi-segment-capture-run",
            "status": "pass",
            "parameters": parameters,
            "sourceModel": {
                "graphSha256": source_sha,
            },
            "artifacts": {
                "manifest": "split/split-manifest.json",
                "manifestSha256": summary_manifest_sha,
                "segmentCount": 2,
                "maximumSegmentArtifactBytes": 123,
                "effectiveRequiredMaxBytes": 256 * 1024 * 1024,
            },
            "evidence": {
                "path": evidence_path,
                "sha256": evidence_sha,
                "verificationSha256": verification_sha,
            },
        }
        (capture / "run-summary.json").write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return capture, summary, evidence

    def test_happy_path_remeasures_and_cross_binds_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            capture, _summary, _evidence = self._write_bundle(Path(raw_dir))
            with patch.object(
                bundle_module,
                "verify_artifact_integrity",
                return_value=self._integrity(),
            ) as verify:
                report = bundle_module.verify_capture_bundle(capture)

            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["captureStatus"], "pass")
            self.assertEqual(report["manifestSha256"], "a" * 64)
            self.assertEqual(report["segmentCount"], 2)
            self.assertEqual(report["sourceGraphSha256"], "c" * 64)
            verify.assert_called_once_with(
                (capture / "split" / "split-manifest.json").resolve()
            )

    def test_tampered_evidence_file_is_rejected_by_summary_digest(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            capture, _summary, _evidence = self._write_bundle(Path(raw_dir))
            evidence_path = capture / "same-machine-evidence.json"
            evidence_path.write_text('{"tampered":true}\n', encoding="utf-8")

            with patch.object(
                bundle_module,
                "verify_artifact_integrity",
                return_value=self._integrity(),
            ):
                with self.assertRaisesRegex(ValueError, "evidence SHA-256 mismatch"):
                    bundle_module.verify_capture_bundle(capture)

    def test_evidence_path_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, summary, _evidence = self._write_bundle(root)
            outside = root / "outside.json"
            outside.write_text("{}\n", encoding="utf-8")
            summary["evidence"]["path"] = "../outside.json"
            summary["evidence"]["sha256"] = bundle_module.sha256_file(outside)
            (capture / "run-summary.json").write_text(
                json.dumps(summary) + "\n",
                encoding="utf-8",
            )

            with patch.object(
                bundle_module,
                "verify_artifact_integrity",
                return_value=self._integrity(),
            ):
                with self.assertRaisesRegex(ValueError, "unsafe run-summary.evidence.path"):
                    bundle_module.verify_capture_bundle(capture)

    def test_embedded_verification_digest_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            capture, summary, evidence = self._write_bundle(Path(raw_dir))
            evidence["verification"]["provider"] = "CUDAExecutionProvider"
            evidence_path = capture / "same-machine-evidence.json"
            evidence_path.write_text(
                json.dumps(evidence, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            summary["evidence"]["sha256"] = bundle_module.sha256_file(evidence_path)
            (capture / "run-summary.json").write_text(
                json.dumps(summary) + "\n",
                encoding="utf-8",
            )

            with patch.object(
                bundle_module,
                "verify_artifact_integrity",
                return_value=self._integrity(),
            ):
                with self.assertRaisesRegex(ValueError, "verification SHA-256 mismatch"):
                    bundle_module.verify_capture_bundle(capture)

    def test_measured_manifest_identity_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            capture, _summary, _evidence = self._write_bundle(
                Path(raw_dir),
                summary_manifest_sha="d" * 64,
            )
            with patch.object(
                bundle_module,
                "verify_artifact_integrity",
                return_value=self._integrity(),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "run-summary.artifacts.manifestSha256 vs measured integrity mismatch",
                ):
                    bundle_module.verify_capture_bundle(capture)

    def test_rejects_coercible_summary_artifact_identity(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            capture, summary, _evidence = self._write_bundle(Path(raw_dir))
            summary["artifacts"]["segmentCount"] = 2.0
            (capture / "run-summary.json").write_text(
                json.dumps(summary) + "\n",
                encoding="utf-8",
            )

            with patch.object(
                bundle_module,
                "verify_artifact_integrity",
                return_value=self._integrity(),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "run-summary.artifacts.segmentCount must be a positive integer",
                ):
                    bundle_module.verify_capture_bundle(capture)

    def test_run_parameter_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            capture, summary, _evidence = self._write_bundle(Path(raw_dir))
            summary["parameters"]["inputTokenIds"] = [99]
            (capture / "run-summary.json").write_text(
                json.dumps(summary) + "\n",
                encoding="utf-8",
            )

            with patch.object(
                bundle_module,
                "verify_artifact_integrity",
                return_value=self._integrity(),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "run-summary.parameters.inputTokenIds vs evidence.parameters mismatch",
                ):
                    bundle_module.verify_capture_bundle(capture)


if __name__ == "__main__":
    unittest.main()
