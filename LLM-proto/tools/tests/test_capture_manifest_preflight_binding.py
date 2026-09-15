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

import capture_multi_segment_evidence_run as capture_module  # noqa: E402


class CaptureManifestPreflightBindingTest(unittest.TestCase):
    def test_manifest_replacement_between_provenance_and_preflight_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "model_q4.onnx"
            source.write_bytes(b"model")
            destination = root / "capture"

            def prepare(source_path: Path, output: Path, **_kwargs: object) -> dict[str, object]:
                output.mkdir(parents=True, exist_ok=True)
                (output / "segment0.onnx").write_bytes(b"segment")
                manifest = {
                    "sourceModel": {"sha256": capture_module.sha256_file(source_path)}
                }
                (output / "split-manifest.json").write_text(
                    json.dumps(manifest) + "\n",
                    encoding="utf-8",
                )
                return {"kind": "fixture"}

            def replace_then_preflight(manifest_path: Path) -> dict[str, object]:
                replacement = {
                    "sourceModel": {"sha256": capture_module.sha256_file(source)},
                    "replacement": True,
                }
                raw = (json.dumps(replacement) + "\n").encode("utf-8")
                manifest_path.write_bytes(raw)
                digest = hashlib.sha256(raw).hexdigest()
                integrity = {
                    "status": "pass",
                    "manifestSha256": digest,
                    "segmentCount": 1,
                    "maximumSegmentArtifactBytes": 7,
                    "effectiveRequiredMaxBytes": 256 * 1024 * 1024,
                }
                return {
                    "schemaVersion": capture_module.SNAPSHOT_REPORT_SCHEMA_VERSION,
                    "kind": capture_module.SNAPSHOT_REPORT_KIND,
                    "status": "pass",
                    "decisionStatus": "diagnostic-only",
                    "pathResolutionMode": capture_module.PATH_RESOLUTION_COMPONENT_ANCHORED,
                    "manifestSha256": digest,
                    "segmentCount": 1,
                    "artifactFileCount": 1,
                    "artifacts": [
                        {
                            "field": "segments[0].path",
                            "path": "segment0.onnx",
                            "bytes": 7,
                            "sha256": "c" * 64,
                        }
                    ],
                    "integrity": integrity,
                }

            with (
                patch.object(
                    capture_module,
                    "prepare_budgeted_multi_split",
                    side_effect=prepare,
                ),
                patch.object(
                    capture_module,
                    "verify_artifact_snapshot",
                    side_effect=replace_then_preflight,
                ) as preflight,
                patch.object(capture_module, "collect_evidence") as collect,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "manifest drifted between source provenance check and artifact preflight",
                ):
                    capture_module.capture_run(source, destination, [11])

            preflight.assert_called_once()
            collect.assert_not_called()
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
