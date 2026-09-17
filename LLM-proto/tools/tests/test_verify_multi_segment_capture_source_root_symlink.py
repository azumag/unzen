from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_source as source_module  # noqa: E402


class VerifyMultiSegmentCaptureSourceRootSymlinkTest(unittest.TestCase):
    @staticmethod
    def _sha(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def _write_capture(self, root: Path, model: Path) -> Path:
        capture = root / "capture"
        split = capture / "split"
        split.mkdir(parents=True)

        graph_sha = self._sha(model)
        manifest = {
            "sourceModel": {
                "sha256": graph_sha,
                "externalData": [],
            }
        }
        (split / "split-manifest.json").write_text(
            json.dumps(manifest) + "\n",
            encoding="utf-8",
        )
        evidence = {
            "verification": {
                "sourceModel": {
                    "graphBytes": model.stat().st_size,
                    "graphSha256": graph_sha,
                    "externalData": [],
                    "allExternalDataHashed": True,
                }
            }
        }
        (capture / "same-machine-evidence.json").write_text(
            json.dumps(evidence) + "\n",
            encoding="utf-8",
        )
        (capture / "run-summary.json").write_text(
            json.dumps(
                {
                    "artifacts": {"manifest": "split/split-manifest.json"},
                    "evidence": {"path": "same-machine-evidence.json"},
                }
            )
            + "\n",
            encoding="utf-8",
        )
        return capture

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

    def _require_component_walk(self) -> None:
        if not source_module._component_walk_supported():
            self.skipTest("component-anchored dirfd traversal unavailable")

    def test_symlinked_source_root_fails_before_source_hashing(self) -> None:
        self._require_component_walk()
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            real_source = root / "real-source"
            real_source.mkdir()
            real_model = real_source / "model.onnx"
            real_model.write_bytes(b"graph")

            source_alias = root / "source"
            try:
                os.symlink(real_source.name, source_alias, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"directory symlinks unavailable: {error}")
            model = source_alias / real_model.name

            capture = self._write_capture(root, model)
            bundle = self._bundle_report(capture, model)

            with (
                patch.object(source_module, "verify_capture_bundle", return_value=bundle),
                patch.object(
                    source_module,
                    "_sha256_fd",
                    wraps=source_module._sha256_fd,
                ) as hasher,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "source model directory must not be a symlink",
                ):
                    source_module.verify_capture_source(capture, model)

            hasher.assert_not_called()

    def test_real_source_root_still_verifies(self) -> None:
        self._require_component_walk()
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "source"
            source.mkdir()
            model = source / "model.onnx"
            model.write_bytes(b"graph")
            capture = self._write_capture(root, model)
            bundle = self._bundle_report(capture, model)

            with patch.object(source_module, "verify_capture_bundle", return_value=bundle):
                report = source_module.verify_capture_source(capture, model)

            self.assertEqual(report["status"], "pass")
            self.assertEqual(
                report["sourcePathResolutionMode"],
                source_module.PATH_RESOLUTION_COMPONENT_ANCHORED,
            )


if __name__ == "__main__":
    unittest.main()
