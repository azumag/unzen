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


class VerifyMultiSegmentCaptureSourceCanonicalPathsTest(unittest.TestCase):
    @staticmethod
    def _write_json(path: Path, value: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) + "\n", encoding="utf-8")

    def _fixture(
        self,
        root: Path,
        *,
        location: str,
        create_external: bool,
    ) -> tuple[Path, Path, dict[str, object]]:
        source_dir = root / "source"
        source_dir.mkdir()
        model = source_dir / "model_q4.onnx"
        model.write_bytes(b"graph-bytes")
        graph_sha = hashlib.sha256(model.read_bytes()).hexdigest()

        external_path = source_dir / Path(location)
        if create_external:
            external_path.parent.mkdir(parents=True, exist_ok=True)
            external_path.write_bytes(b"external-weights")
            external_bytes = external_path.stat().st_size
            external_sha = hashlib.sha256(external_path.read_bytes()).hexdigest()
        else:
            external_bytes = 0
            external_sha = "0" * 64

        external = {
            "location": location,
            "bytes": external_bytes,
            "sha256": external_sha,
        }
        capture = root / "capture"
        manifest_path = capture / "split" / "split-manifest.json"
        evidence_path = capture / "same-machine-evidence.json"
        summary_path = capture / "run-summary.json"
        self._write_json(
            manifest_path,
            {"sourceModel": {"sha256": graph_sha, "externalData": [external]}},
        )
        self._write_json(
            evidence_path,
            {
                "verification": {
                    "sourceModel": {
                        "graphBytes": model.stat().st_size,
                        "graphSha256": graph_sha,
                        "externalData": [external],
                        "allExternalDataHashed": True,
                    }
                }
            },
        )
        self._write_json(
            summary_path,
            {
                "artifacts": {"manifest": "split/split-manifest.json"},
                "evidence": {"path": "same-machine-evidence.json"},
            },
        )
        bundle = {
            "status": "pass",
            "captureStatus": "pass",
            "runSummarySha256": source_module.sha256_file(summary_path),
            "manifestSha256": source_module.sha256_file(manifest_path),
            "evidenceSha256": source_module.sha256_file(evidence_path),
            "verificationSha256": "f" * 64,
            "sourceGraphSha256": graph_sha,
        }
        return capture, model, bundle

    def test_noncanonical_external_locations_fail_before_source_hashing(self) -> None:
        aliases = (
            "./weights.bin",
            "dir/./weights.bin",
            r"dir\.\weights.bin",
            "dir//weights.bin",
            r"dir\\weights.bin",
            "dir/weights.bin/",
        )
        for location in aliases:
            with self.subTest(location=location), tempfile.TemporaryDirectory() as raw_dir:
                capture, model, bundle = self._fixture(
                    Path(raw_dir),
                    location=location,
                    create_external=False,
                )
                with (
                    patch.object(source_module, "verify_capture_bundle", return_value=bundle),
                    patch.object(source_module, "_sha256_fd") as hasher,
                ):
                    with self.assertRaisesRegex(ValueError, "unsafe .*location"):
                        source_module.verify_capture_source(capture, model)
                hasher.assert_not_called()

    def test_canonical_nested_external_location_still_passes(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            capture, model, bundle = self._fixture(
                Path(raw_dir),
                location="nested/weights.bin",
                create_external=True,
            )
            with patch.object(source_module, "verify_capture_bundle", return_value=bundle):
                report = source_module.verify_capture_source(capture, model)

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["sourceExternalDataCount"], 1)
        self.assertEqual(report["sourceExternalData"][0]["location"], "nested/weights.bin")


if __name__ == "__main__":
    unittest.main()
