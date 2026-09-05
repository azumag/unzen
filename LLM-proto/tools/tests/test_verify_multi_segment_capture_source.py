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

import verify_multi_segment_capture_source as source_module  # noqa: E402


class VerifyMultiSegmentCaptureSourceTest(unittest.TestCase):
    def _write_fixture(self, root: Path) -> tuple[Path, Path, Path]:
        source_dir = root / "source"
        source_dir.mkdir()
        model = source_dir / "model_q4.onnx"
        weights = source_dir / "model_q4.onnx_data"
        model.write_bytes(b"graph-bytes")
        weights.write_bytes(b"external-weights")
        graph_sha = hashlib.sha256(model.read_bytes()).hexdigest()
        weight_sha = hashlib.sha256(weights.read_bytes()).hexdigest()

        capture = root / "capture"
        split = capture / "split"
        split.mkdir(parents=True)
        manifest = {
            "sourceModel": {
                "sha256": graph_sha,
                "externalData": [
                    {
                        "location": weights.name,
                        "bytes": weights.stat().st_size,
                        "sha256": weight_sha,
                    }
                ],
            }
        }
        manifest_path = split / "split-manifest.json"
        manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")

        verification = {
            "sourceModel": {
                "graphBytes": model.stat().st_size,
                "graphSha256": graph_sha,
                "externalData": [
                    {
                        "location": weights.name,
                        "bytes": weights.stat().st_size,
                        "sha256": weight_sha,
                    }
                ],
                "allExternalDataHashed": True,
            }
        }
        evidence_path = capture / "same-machine-evidence.json"
        evidence_path.write_text(
            json.dumps({"verification": verification}) + "\n",
            encoding="utf-8",
        )
        summary_path = capture / "run-summary.json"
        summary_path.write_text(
            json.dumps(
                {
                    "artifacts": {"manifest": "split/split-manifest.json"},
                    "evidence": {"path": "same-machine-evidence.json"},
                }
            )
            + "\n",
            encoding="utf-8",
        )
        return capture, model, weights

    @staticmethod
    def _bundle_report(capture: Path, model: Path) -> dict[str, object]:
        manifest = capture / "split" / "split-manifest.json"
        evidence = capture / "same-machine-evidence.json"
        summary = capture / "run-summary.json"
        return {
            "status": "pass",
            "captureStatus": "pass",
            "runSummarySha256": source_module.sha256_file(summary),
            "manifestSha256": source_module.sha256_file(manifest),
            "evidenceSha256": source_module.sha256_file(evidence),
            "sourceGraphSha256": source_module.sha256_file(model),
        }

    def test_happy_path_rehashes_source_graph_and_external_data(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, model, weights = self._write_fixture(root)
            with patch.object(
                source_module,
                "verify_capture_bundle",
                return_value=self._bundle_report(capture, model),
            ):
                report = source_module.verify_capture_source(capture, model)

            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["sourceGraphBytes"], model.stat().st_size)
            self.assertEqual(report["sourceExternalDataCount"], 1)
            self.assertEqual(report["sourceExternalDataBytes"], weights.stat().st_size)
            self.assertEqual(report["sourceExternalData"][0]["location"], weights.name)

    def test_tampered_source_external_data_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, model, weights = self._write_fixture(root)
            bundle = self._bundle_report(capture, model)
            weights.write_bytes(b"tampered-weights")
            with patch.object(source_module, "verify_capture_bundle", return_value=bundle):
                with self.assertRaisesRegex(ValueError, "source external-data SHA-256"):
                    source_module.verify_capture_source(capture, model)

    def test_manifest_source_external_path_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, model, _weights = self._write_fixture(root)
            manifest_path = capture / "split" / "split-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["sourceModel"]["externalData"][0]["location"] = "../outside.bin"
            manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")
            bundle = self._bundle_report(capture, model)
            with patch.object(source_module, "verify_capture_bundle", return_value=bundle):
                with self.assertRaisesRegex(ValueError, "unsafe .*location"):
                    source_module.verify_capture_source(capture, model)

    def test_embedded_source_identity_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, model, _weights = self._write_fixture(root)
            evidence_path = capture / "same-machine-evidence.json"
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            evidence["verification"]["sourceModel"]["externalData"][0]["sha256"] = (
                "f" * 64
            )
            evidence_path.write_text(json.dumps(evidence) + "\n", encoding="utf-8")
            bundle = self._bundle_report(capture, model)
            with patch.object(source_module, "verify_capture_bundle", return_value=bundle):
                with self.assertRaisesRegex(
                    ValueError,
                    "external data vs embedded verification",
                ):
                    source_module.verify_capture_source(capture, model)

    def test_source_graph_digest_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, model, _weights = self._write_fixture(root)
            bundle = self._bundle_report(capture, model)
            model.write_bytes(b"different-graph")
            with patch.object(source_module, "verify_capture_bundle", return_value=bundle):
                with self.assertRaisesRegex(ValueError, "source graph SHA-256"):
                    source_module.verify_capture_source(capture, model)

    def test_source_file_mutation_during_hash_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, model, weights = self._write_fixture(root)
            bundle = self._bundle_report(capture, model)
            real_hasher = source_module.sha256_file

            def mutating_hasher(path: Path) -> str:
                digest = real_hasher(path)
                if path == weights:
                    path.write_bytes(path.read_bytes() + b"!")
                return digest

            with patch.object(source_module, "verify_capture_bundle", return_value=bundle):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "changed while it was being hashed",
                ):
                    source_module.verify_capture_source(
                        capture,
                        model,
                        file_hasher=mutating_hasher,
                    )


if __name__ == "__main__":
    unittest.main()
