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


class VerifyMultiSegmentCaptureSourceControlSnapshotTest(unittest.TestCase):
    def _write_fixture(self, root: Path) -> tuple[Path, Path]:
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
        return capture, model

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

    def test_control_files_are_read_as_stable_snapshots_without_pathname_rehash(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            capture, model = self._write_fixture(root)
            bundle = self._bundle_report(capture, model)
            real_stable_reader = source_module._stable_json_object

            with (
                patch.object(source_module, "verify_capture_bundle", return_value=bundle),
                patch.object(
                    source_module,
                    "_stable_json_object",
                    wraps=real_stable_reader,
                ) as stable_reader,
                patch.object(
                    source_module,
                    "sha256_file",
                    side_effect=AssertionError(
                        "control-file pathname must not be re-hashed after parsing"
                    ),
                ),
            ):
                report = source_module.verify_capture_source(capture, model)

            self.assertEqual(report["status"], "pass")
            self.assertEqual(stable_reader.call_count, 3)

    def test_same_content_control_file_symlinks_are_rejected(self) -> None:
        control_paths = (
            Path("run-summary.json"),
            Path("split/split-manifest.json"),
            Path("same-machine-evidence.json"),
        )
        for relative_path in control_paths:
            with self.subTest(path=str(relative_path)):
                with tempfile.TemporaryDirectory() as raw_dir:
                    root = Path(raw_dir)
                    capture, model = self._write_fixture(root)
                    bundle = self._bundle_report(capture, model)
                    target = capture / relative_path
                    original = target.with_name(target.name + ".original")
                    target.rename(original)
                    target.symlink_to(original.name)

                    with patch.object(
                        source_module,
                        "verify_capture_bundle",
                        return_value=bundle,
                    ):
                        with self.assertRaisesRegex(ValueError, "must not be a symlink"):
                            source_module.verify_capture_source(capture, model)


if __name__ == "__main__":
    unittest.main()
