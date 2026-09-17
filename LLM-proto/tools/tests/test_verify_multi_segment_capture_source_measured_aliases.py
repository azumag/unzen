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


class VerifyMultiSegmentCaptureSourceMeasuredAliasesTest(unittest.TestCase):
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
        (split / "split-manifest.json").write_text(
            json.dumps(
                {
                    "sourceModel": {
                        "sha256": self._sha(model),
                        "externalData": external,
                    }
                }
            )
            + "\n",
            encoding="utf-8",
        )
        (capture / "same-machine-evidence.json").write_text(
            json.dumps(
                {
                    "verification": {
                        "sourceModel": {
                            "graphBytes": model.stat().st_size,
                            "graphSha256": self._sha(model),
                            "externalData": external,
                            "allExternalDataHashed": True,
                        }
                    }
                }
            )
            + "\n",
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

    def _replace_with_hard_link(self, target: Path, source: Path) -> None:
        target.unlink()
        try:
            os.link(source, target)
        except OSError as error:
            self.skipTest(f"hard links unavailable: {error}")

    def test_graph_external_alias_created_after_preflight_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "source"
            source.mkdir()
            model = source / "model.onnx"
            weights = source / "weights.bin"
            model.write_bytes(b"same-payload")
            weights.write_bytes(b"same-payload")
            capture = self._write_capture(root, model, [weights])
            bundle = self._bundle_report(capture, model)
            original_preflight = source_module._preflight_source_file_identities

            def preflight_then_alias(*args: object, **kwargs: object) -> None:
                original_preflight(*args, **kwargs)
                self._replace_with_hard_link(weights, model)

            with (
                patch.object(source_module, "verify_capture_bundle", return_value=bundle),
                patch.object(
                    source_module,
                    "_preflight_source_file_identities",
                    side_effect=preflight_then_alias,
                ),
                patch.object(
                    source_module,
                    "_sha256_fd",
                    wraps=source_module._sha256_fd,
                ) as hasher,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "source provenance measured hard-link alias: source external data weights.bin aliases full model graph",
                ):
                    source_module.verify_capture_source(capture, model)

            self.assertEqual(hasher.call_count, 1)

    def test_external_alias_created_after_preflight_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "source"
            source.mkdir()
            model = source / "model.onnx"
            first = source / "weights-a.bin"
            second = source / "weights-b.bin"
            model.write_bytes(b"graph")
            first.write_bytes(b"same-payload")
            second.write_bytes(b"same-payload")
            capture = self._write_capture(root, model, [first, second])
            bundle = self._bundle_report(capture, model)
            original_preflight = source_module._preflight_source_file_identities

            def preflight_then_alias(*args: object, **kwargs: object) -> None:
                original_preflight(*args, **kwargs)
                self._replace_with_hard_link(second, first)

            with (
                patch.object(source_module, "verify_capture_bundle", return_value=bundle),
                patch.object(
                    source_module,
                    "_preflight_source_file_identities",
                    side_effect=preflight_then_alias,
                ),
                patch.object(
                    source_module,
                    "_sha256_fd",
                    wraps=source_module._sha256_fd,
                ) as hasher,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "source provenance measured hard-link alias: source external data weights-b.bin aliases source external data weights-a.bin",
                ):
                    source_module.verify_capture_source(capture, model)

            self.assertEqual(hasher.call_count, 2)


if __name__ == "__main__":
    unittest.main()
