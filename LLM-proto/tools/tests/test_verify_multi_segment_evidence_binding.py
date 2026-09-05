from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from verify_multi_segment_onnx import verify_multi_split  # noqa: E402


class VerifyMultiSegmentEvidenceBindingTest(unittest.TestCase):
    def _sha(self, payload: bytes) -> str:
        return hashlib.sha256(payload).hexdigest()

    def _fixture(self, root: Path) -> tuple[Path, Path, Path]:
        source_payload = b"full-model-graph"
        segment_payload = b"segment-graph"
        source = root / "model_q4.onnx"
        segment = root / "segment0.onnx"
        source.write_bytes(source_payload)
        segment.write_bytes(segment_payload)

        artifact_bytes = len(segment_payload)
        manifest = {
            "schemaVersion": "1.0.0",
            "kind": "unzen-budgeted-multi-segment-onnx",
            "sourceModel": {
                "path": str(source),
                "sha256": self._sha(source_payload),
                "externalData": [],
            },
            "artifactLayout": "per-segment-external-data",
            "splitPlan": {
                "requiredMaxBytes": 1024,
                "maximumGeneratedSegmentBytes": artifact_bytes,
                "cutLayers": [],
            },
            "browserArtifactBudget": {
                "preferredMaxBytes": 1024,
                "normalMaxBytes": 2048,
                "absoluteMaxBytes": 4096,
                "requiredMaxBytes": 1024,
                "maximumSegmentArtifactBytes": artifact_bytes,
                "segments": [
                    {
                        "index": 0,
                        "artifactBytes": artifact_bytes,
                        "tier": "preferred",
                    }
                ],
            },
            "boundaries": [],
            "segments": [
                {
                    "index": 0,
                    "path": segment.name,
                    "sha256": self._sha(segment_payload),
                    "startLayer": 0,
                    "endLayer": 1,
                    "inputs": ["input_ids"],
                    "outputs": ["logits"],
                    "externalData": [],
                    "browserArtifactBytes": artifact_bytes,
                    "browserArtifactTier": "preferred",
                }
            ],
        }
        manifest_path = root / "split-manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return source, segment, manifest_path

    def test_rejects_tampered_segment_before_onnx_runtime_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, segment, manifest = self._fixture(root)
            segment.write_bytes(b"tampered-segment")

            with self.assertRaisesRegex(ValueError, "graph SHA-256 mismatch"):
                verify_multi_split(source, manifest, [1])

    def test_rejects_different_full_model_before_onnx_runtime_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, _segment, manifest = self._fixture(root)
            source.write_bytes(b"different-full-model")

            with self.assertRaisesRegex(ValueError, "full-model graph SHA-256 mismatch"):
                verify_multi_split(source, manifest, [1])

    def test_rejects_source_external_data_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, _segment, manifest_path = self._fixture(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["sourceModel"]["externalData"] = [
                {
                    "location": "../weights.bin",
                    "bytes": 1,
                    "sha256": self._sha(b"x"),
                }
            ]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "unsafe sourceModel.*location"):
                verify_multi_split(source, manifest_path, [1])

    def test_rejects_unhashed_source_external_data_before_onnx_runtime_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, _segment, manifest_path = self._fixture(root)
            weights_payload = b"source-external-weights"
            weights_path = root / "model_q4.onnx_data"
            weights_path.write_bytes(weights_payload)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["sourceModel"]["externalData"] = [
                {
                    "location": weights_path.name,
                    "bytes": len(weights_payload),
                }
            ]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaisesRegex(
                ValueError,
                "sha256 is required for numerical evidence binding",
            ):
                verify_multi_split(source, manifest_path, [1])


if __name__ == "__main__":
    unittest.main()
