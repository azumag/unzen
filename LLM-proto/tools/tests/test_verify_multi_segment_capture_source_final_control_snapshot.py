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


class VerifyMultiSegmentCaptureSourceFinalControlSnapshotTest(unittest.TestCase):
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
        manifest_path = split / "split-manifest.json"
        manifest_path.write_text(
            json.dumps(
                {
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
            )
            + "\n",
            encoding="utf-8",
        )

        evidence_path = capture / "same-machine-evidence.json"
        evidence_path.write_text(
            json.dumps(
                {
                    "verification": {
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
                }
            )
            + "\n",
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
        return {
            "status": "pass",
            "captureStatus": "pass",
            "runSummarySha256": source_module.sha256_file(capture / "run-summary.json"),
            "manifestSha256": source_module.sha256_file(
                capture / "split" / "split-manifest.json"
            ),
            "evidenceSha256": source_module.sha256_file(
                capture / "same-machine-evidence.json"
            ),
            "verificationSha256": "f" * 64,
            "sourceGraphSha256": source_module.sha256_file(model),
        }

    @staticmethod
    def _rewrite_json(path: Path, marker: str) -> None:
        value = json.loads(path.read_text(encoding="utf-8"))
        value["auditMutation"] = marker
        path.write_text(json.dumps(value) + "\n", encoding="utf-8")

    def test_run_summary_changed_during_source_hash_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, model, _weights = self._write_fixture(root)
            bundle = self._bundle_report(capture, model)
            summary_path = capture / "run-summary.json"
            real_hasher = source_module._sha256_fd
            mutated = False

            def mutating_hasher(fd: int) -> str:
                nonlocal mutated
                digest = real_hasher(fd)
                if not mutated:
                    mutated = True
                    self._rewrite_json(summary_path, "during-source-hash")
                return digest

            with (
                patch.object(source_module, "verify_capture_bundle", return_value=bundle),
                patch.object(source_module, "_sha256_fd", side_effect=mutating_hasher),
            ):
                with self.assertRaisesRegex(ValueError, "run summary final snapshot"):
                    source_module.verify_capture_source(capture, model)

    def test_manifest_changed_during_source_hash_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, model, _weights = self._write_fixture(root)
            bundle = self._bundle_report(capture, model)
            manifest_path = capture / "split" / "split-manifest.json"
            real_hasher = source_module._sha256_fd
            mutated = False

            def mutating_hasher(fd: int) -> str:
                nonlocal mutated
                digest = real_hasher(fd)
                if not mutated:
                    mutated = True
                    self._rewrite_json(manifest_path, "during-source-hash")
                return digest

            with (
                patch.object(source_module, "verify_capture_bundle", return_value=bundle),
                patch.object(source_module, "_sha256_fd", side_effect=mutating_hasher),
            ):
                with self.assertRaisesRegex(ValueError, "split manifest final snapshot"):
                    source_module.verify_capture_source(capture, model)

    def test_evidence_changed_after_first_source_read_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, model, _weights = self._write_fixture(root)
            bundle = self._bundle_report(capture, model)
            evidence_path = capture / "same-machine-evidence.json"
            real_reader = source_module._stable_json_object
            evidence_reads = 0

            def mutating_reader(path: Path, *, field: str):
                nonlocal evidence_reads
                value, digest = real_reader(path, field=field)
                if path == evidence_path:
                    evidence_reads += 1
                    if evidence_reads == 1:
                        self._rewrite_json(evidence_path, "after-first-read")
                return value, digest

            with (
                patch.object(source_module, "verify_capture_bundle", return_value=bundle),
                patch.object(source_module, "_stable_json_object", side_effect=mutating_reader),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "same-machine evidence final snapshot",
                ):
                    source_module.verify_capture_source(capture, model)

            self.assertEqual(evidence_reads, 2)

    def test_unchanged_controls_are_revalidated_and_pass(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, model, _weights = self._write_fixture(root)
            bundle = self._bundle_report(capture, model)
            real_reader = source_module._stable_json_object

            with (
                patch.object(source_module, "verify_capture_bundle", return_value=bundle),
                patch.object(
                    source_module,
                    "_stable_json_object",
                    wraps=real_reader,
                ) as stable_reader,
            ):
                report = source_module.verify_capture_source(capture, model)

            self.assertEqual(report["status"], "pass")
            self.assertEqual(stable_reader.call_count, 6)


if __name__ == "__main__":
    unittest.main()
