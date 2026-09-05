from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import capture_multi_segment_evidence_run as capture_module  # noqa: E402


class CaptureMultiSegmentEvidenceRunTest(unittest.TestCase):
    def _prepare_fixture(self, _source: Path, output: Path, **_kwargs: object) -> dict[str, object]:
        output.mkdir(parents=True, exist_ok=True)
        (output / "segment0.onnx").write_bytes(b"segment")
        (output / "split-manifest.json").write_text("{}\n", encoding="utf-8")
        return {"kind": "fixture"}

    @staticmethod
    def _integrity(*, status: str = "pass") -> dict[str, object]:
        return {
            "status": status,
            "manifestSha256": "a" * 64,
            "segmentCount": 1,
            "maximumSegmentArtifactBytes": 7,
            "effectiveRequiredMaxBytes": 256 * 1024 * 1024,
        }

    @staticmethod
    def _evidence(*, status: str = "pass") -> dict[str, object]:
        return {
            "schemaVersion": "1.0.0",
            "kind": "unzen-budgeted-multi-segment-evidence-bundle",
            "status": status,
            "verificationSha256": "b" * 64,
            "verification": {"status": status},
        }

    def test_happy_path_publishes_complete_bundle_and_forces_source_hashing(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            destination = root / "capture"
            source = root / "model_q4.onnx"
            source.write_bytes(b"model")

            with (
                patch.object(
                    capture_module,
                    "prepare_budgeted_multi_split",
                    side_effect=self._prepare_fixture,
                ) as prepare,
                patch.object(
                    capture_module,
                    "verify_artifact_integrity",
                    return_value=self._integrity(),
                ),
                patch.object(
                    capture_module,
                    "collect_evidence",
                    return_value=self._evidence(),
                ) as collect,
            ):
                summary = capture_module.capture_run(
                    source,
                    destination,
                    [11, 22],
                    hidden_size=2048,
                    target_bytes=200 * 1024 * 1024,
                    preferred_max_bytes=256 * 1024 * 1024,
                    kv_heads=8,
                    head_size=64,
                )

            self.assertEqual(summary["status"], "pass")
            self.assertTrue((destination / "split" / "split-manifest.json").is_file())
            self.assertTrue((destination / "same-machine-evidence.json").is_file())
            self.assertTrue((destination / "run-summary.json").is_file())
            persisted = json.loads(
                (destination / "run-summary.json").read_text(encoding="utf-8")
            )
            self.assertEqual(persisted["artifacts"]["manifestSha256"], "a" * 64)
            self.assertEqual(persisted["artifacts"]["segmentCount"], 1)
            self.assertEqual(persisted["evidence"]["verificationSha256"], "b" * 64)
            self.assertNotIn(str(root), json.dumps(persisted))

            prepare.assert_called_once()
            self.assertTrue(prepare.call_args.kwargs["hash_source_external_data"])
            collect.assert_called_once()
            self.assertEqual(collect.call_args.args[2], [11, 22])

            leftovers = [
                path
                for path in root.iterdir()
                if path.name.startswith(".capture.") and path.name.endswith(".tmp")
            ]
            self.assertEqual(leftovers, [])

    def test_existing_destination_is_rejected_before_generation(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            destination = root / "capture"
            destination.mkdir()
            with patch.object(capture_module, "prepare_budgeted_multi_split") as prepare:
                with self.assertRaisesRegex(FileExistsError, "already exists"):
                    capture_module.capture_run(
                        root / "model_q4.onnx",
                        destination,
                        [11],
                    )
            prepare.assert_not_called()

    def test_preflight_failure_cleans_staging_and_skips_numerical_work(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            destination = root / "capture"
            with (
                patch.object(
                    capture_module,
                    "prepare_budgeted_multi_split",
                    side_effect=self._prepare_fixture,
                ),
                patch.object(
                    capture_module,
                    "verify_artifact_integrity",
                    return_value=self._integrity(status="fail"),
                ),
                patch.object(capture_module, "collect_evidence") as collect,
            ):
                with self.assertRaisesRegex(RuntimeError, "did not pass"):
                    capture_module.capture_run(
                        root / "model_q4.onnx",
                        destination,
                        [11],
                    )

            collect.assert_not_called()
            self.assertFalse(destination.exists())
            leftovers = [
                path
                for path in root.iterdir()
                if path.name.startswith(".capture.") and path.name.endswith(".tmp")
            ]
            self.assertEqual(leftovers, [])

    def test_numerical_mismatch_is_published_as_useful_failed_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            destination = root / "capture"
            with (
                patch.object(
                    capture_module,
                    "prepare_budgeted_multi_split",
                    side_effect=self._prepare_fixture,
                ),
                patch.object(
                    capture_module,
                    "verify_artifact_integrity",
                    return_value=self._integrity(),
                ),
                patch.object(
                    capture_module,
                    "collect_evidence",
                    return_value=self._evidence(status="fail"),
                ),
            ):
                summary = capture_module.capture_run(
                    root / "model_q4.onnx",
                    destination,
                    [11],
                )

            self.assertEqual(summary["status"], "fail")
            self.assertTrue(destination.is_dir())
            persisted = json.loads(
                (destination / "run-summary.json").read_text(encoding="utf-8")
            )
            self.assertEqual(persisted["status"], "fail")


if __name__ == "__main__":
    unittest.main()
