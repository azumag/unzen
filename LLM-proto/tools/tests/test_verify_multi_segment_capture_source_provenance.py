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

import verify_multi_segment_capture_source_provenance as provenance  # noqa: E402


class CaptureSourceProvenanceVerifierTest(unittest.TestCase):
    GRAPH_SHA = "a" * 64
    EXTERNAL_SHA = "b" * 64

    @staticmethod
    def _write_json(path: Path, value: object) -> str:
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = (json.dumps(value, sort_keys=True) + "\n").encode("utf-8")
        path.write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def _bundle(self, root: Path) -> tuple[dict[str, object], dict[str, object]]:
        manifest = {
            "sourceModel": {
                "path": "/operator/models/model_q4.onnx",
                "sha256": self.GRAPH_SHA,
                "externalData": [
                    {
                        "location": "weights.bin",
                        "bytes": 17,
                        "sha256": self.EXTERNAL_SHA,
                    }
                ],
            }
        }
        evidence = {
            "verification": {
                "sourceModel": {
                    "path": "/operator/models/model_q4.onnx",
                    "graphBytes": 1234,
                    "graphSha256": self.GRAPH_SHA,
                    "externalData": [
                        {
                            "location": "weights.bin",
                            "bytes": 17,
                            "sha256": self.EXTERNAL_SHA,
                        }
                    ],
                    "allExternalDataHashed": True,
                }
            }
        }
        summary = {
            "sourceModel": {"graphSha256": self.GRAPH_SHA},
            "artifacts": {"manifest": "split/split-manifest.json"},
            "evidence": {"path": "same-machine-evidence.json"},
        }
        summary_sha = self._write_json(root / "run-summary.json", summary)
        manifest_sha = self._write_json(root / "split" / "split-manifest.json", manifest)
        evidence_sha = self._write_json(root / "same-machine-evidence.json", evidence)
        return (
            {
                "status": "pass",
                "runSummarySha256": summary_sha,
                "manifestSha256": manifest_sha,
                "evidenceSha256": evidence_sha,
            },
            {"summary": summary, "manifest": manifest, "evidence": evidence},
        )

    def test_valid_bundle_cross_binds_graph_and_external_data(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            base, _ = self._bundle(root)
            with patch.object(provenance, "verify_capture_bundle", return_value=base):
                report = provenance.verify_capture_source_provenance(root)

            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["decisionStatus"], "diagnostic-only")
            self.assertEqual(report["sourceGraphSha256"], self.GRAPH_SHA)
            self.assertEqual(report["sourceExternalDataCount"], 1)
            self.assertEqual(report["sourceExternalDataBytes"], 17)
            self.assertEqual(report["runSummarySha256"], base["runSummarySha256"])
            self.assertEqual(report["manifestSha256"], base["manifestSha256"])
            self.assertEqual(report["evidenceSha256"], base["evidenceSha256"])

    def test_external_digest_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            base, bundle = self._bundle(root)
            evidence = bundle["evidence"]
            evidence["verification"]["sourceModel"]["externalData"][0]["sha256"] = "c" * 64
            base["evidenceSha256"] = self._write_json(
                root / "same-machine-evidence.json", evidence
            )

            with patch.object(provenance, "verify_capture_bundle", return_value=base):
                with self.assertRaisesRegex(ValueError, "external-data identity mismatch"):
                    provenance.verify_capture_source_provenance(root)

    def test_graph_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            base, bundle = self._bundle(root)
            manifest = bundle["manifest"]
            manifest["sourceModel"]["sha256"] = "c" * 64
            base["manifestSha256"] = self._write_json(
                root / "split" / "split-manifest.json", manifest
            )

            with patch.object(provenance, "verify_capture_bundle", return_value=base):
                with self.assertRaisesRegex(ValueError, "source graph identity mismatch"):
                    provenance.verify_capture_source_provenance(root)

    def test_duplicate_external_location_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            base, bundle = self._bundle(root)
            manifest = bundle["manifest"]
            manifest["sourceModel"]["externalData"].append(
                {
                    "location": "weights.bin",
                    "bytes": 17,
                    "sha256": self.EXTERNAL_SHA,
                }
            )
            base["manifestSha256"] = self._write_json(
                root / "split" / "split-manifest.json", manifest
            )

            with patch.object(provenance, "verify_capture_bundle", return_value=base):
                with self.assertRaisesRegex(ValueError, "duplicate location"):
                    provenance.verify_capture_source_provenance(root)

    def test_unsafe_external_location_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            base, bundle = self._bundle(root)
            manifest = bundle["manifest"]
            manifest["sourceModel"]["externalData"][0]["location"] = "../weights.bin"
            base["manifestSha256"] = self._write_json(
                root / "split" / "split-manifest.json", manifest
            )

            with patch.object(provenance, "verify_capture_bundle", return_value=base):
                with self.assertRaisesRegex(ValueError, "unsafe .*location"):
                    provenance.verify_capture_source_provenance(root)

    def test_missing_external_digest_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            base, bundle = self._bundle(root)
            manifest = bundle["manifest"]
            del manifest["sourceModel"]["externalData"][0]["sha256"]
            base["manifestSha256"] = self._write_json(
                root / "split" / "split-manifest.json", manifest
            )

            with patch.object(provenance, "verify_capture_bundle", return_value=base):
                with self.assertRaisesRegex(ValueError, "sha256 must be a non-empty string"):
                    provenance.verify_capture_source_provenance(root)

    def test_unhashed_verification_source_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            base, bundle = self._bundle(root)
            evidence = bundle["evidence"]
            evidence["verification"]["sourceModel"]["allExternalDataHashed"] = False
            base["evidenceSha256"] = self._write_json(
                root / "same-machine-evidence.json", evidence
            )

            with patch.object(provenance, "verify_capture_bundle", return_value=base):
                with self.assertRaisesRegex(ValueError, "allExternalDataHashed.*must be true"):
                    provenance.verify_capture_source_provenance(root)

    def test_post_base_verification_digest_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            base, _ = self._bundle(root)
            base["evidenceSha256"] = "f" * 64

            with patch.object(provenance, "verify_capture_bundle", return_value=base):
                with self.assertRaisesRegex(ValueError, "changed after base bundle verification"):
                    provenance.verify_capture_source_provenance(root)

    def test_symlink_summary_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            base, _ = self._bundle(root)
            target = root / "summary-target.json"
            (root / "run-summary.json").replace(target)
            try:
                (root / "run-summary.json").symlink_to(target.name)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation is unavailable")

            with patch.object(provenance, "verify_capture_bundle", return_value=base):
                with self.assertRaisesRegex(ValueError, "must not be a symlink"):
                    provenance.verify_capture_source_provenance(root)


if __name__ == "__main__":
    unittest.main()
