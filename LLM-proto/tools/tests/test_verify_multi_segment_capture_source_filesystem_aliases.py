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


class VerifyMultiSegmentCaptureSourceFilesystemAliasesTest(unittest.TestCase):
    @staticmethod
    def _sha(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def _write_capture(
        self,
        root: Path,
        model: Path,
        external_paths: list[Path],
    ) -> Path:
        capture = root / "capture"
        split = capture / "split"
        split.mkdir(parents=True)

        external = [
            {
                "location": path.name,
                "bytes": path.stat().st_size,
                "sha256": self._sha(path),
            }
            for path in external_paths
        ]
        manifest = {
            "sourceModel": {
                "sha256": self._sha(model),
                "externalData": external,
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
                    "graphSha256": self._sha(model),
                    "externalData": external,
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

    @staticmethod
    def _link(source: Path, destination: Path) -> None:
        try:
            os.link(source, destination)
        except OSError as error:
            raise unittest.SkipTest(f"hard links unavailable: {error}") from error

    def test_external_hard_link_to_graph_fails_before_source_hashing(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "source"
            source.mkdir()
            model = source / "model.onnx"
            model.write_bytes(b"same-source-object")
            graph_alias = source / "graph-alias.bin"
            self._link(model, graph_alias)
            capture = self._write_capture(root, model, [graph_alias])
            bundle = self._bundle_report(capture, model)

            with (
                patch.object(source_module, "verify_capture_bundle", return_value=bundle),
                patch.object(source_module, "_sha256_fd", wraps=source_module._sha256_fd) as hasher,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "source provenance hard-link alias: graph-alias.bin aliases full model graph",
                ):
                    source_module.verify_capture_source(capture, model)

            hasher.assert_not_called()

    def test_external_hard_links_fail_before_source_hashing(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "source"
            source.mkdir()
            model = source / "model.onnx"
            model.write_bytes(b"graph")
            weights_a = source / "weights-a.bin"
            weights_a.write_bytes(b"shared-weights")
            weights_b = source / "weights-b.bin"
            self._link(weights_a, weights_b)
            capture = self._write_capture(root, model, [weights_a, weights_b])
            bundle = self._bundle_report(capture, model)

            with (
                patch.object(source_module, "verify_capture_bundle", return_value=bundle),
                patch.object(source_module, "_sha256_fd", wraps=source_module._sha256_fd) as hasher,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "source provenance hard-link alias: weights-b.bin aliases source external data weights-a.bin",
                ):
                    source_module.verify_capture_source(capture, model)

            hasher.assert_not_called()

    def test_distinct_source_files_still_verify(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "source"
            source.mkdir()
            model = source / "model.onnx"
            model.write_bytes(b"graph")
            weights_a = source / "weights-a.bin"
            weights_a.write_bytes(b"weights-a")
            weights_b = source / "weights-b.bin"
            weights_b.write_bytes(b"weights-b")
            capture = self._write_capture(root, model, [weights_a, weights_b])
            bundle = self._bundle_report(capture, model)

            with patch.object(source_module, "verify_capture_bundle", return_value=bundle):
                report = source_module.verify_capture_source(capture, model)

            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["sourceExternalDataCount"], 2)


if __name__ == "__main__":
    unittest.main()
