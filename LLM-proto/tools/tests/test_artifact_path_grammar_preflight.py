from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_artifacts as verifier  # noqa: E402
from verify_multi_segment_artifacts import verify_artifact_integrity  # noqa: E402


class ArtifactPathGrammarPreflightTest(unittest.TestCase):
    @staticmethod
    def _sha(payload: bytes) -> str:
        return hashlib.sha256(payload).hexdigest()

    def _manifest_with_two_segments(self, root: Path) -> Path:
        zero_graph = b"graph-zero"
        one_graph = b"graph-one"
        zero_external = b"weights-zero"
        one_external = b"weights-one"
        segments = []
        budget_segments = []
        maximum = 0
        for index, graph_payload, external_payload in (
            (0, zero_graph, zero_external),
            (1, one_graph, one_external),
        ):
            artifact_bytes = len(graph_payload) + len(external_payload)
            maximum = max(maximum, artifact_bytes)
            segments.append(
                {
                    "index": index,
                    "path": f"segment{index}.onnx",
                    "sha256": self._sha(graph_payload),
                    "browserArtifactBytes": artifact_bytes,
                    "browserArtifactTier": "preferred",
                    "externalData": [
                        {
                            "location": f"segment{index}.onnx_data",
                            "bytes": len(external_payload),
                            "sha256": self._sha(external_payload),
                        }
                    ],
                }
            )
            budget_segments.append(
                {"index": index, "artifactBytes": artifact_bytes, "tier": "preferred"}
            )

        manifest = {
            "schemaVersion": "1.0.0",
            "kind": "unzen-budgeted-multi-segment-onnx",
            "artifactLayout": "per-segment-external-data",
            "splitPlan": {
                "requiredMaxBytes": 1024,
                "maximumGeneratedSegmentBytes": maximum,
            },
            "browserArtifactBudget": {
                "preferredMaxBytes": 512,
                "normalMaxBytes": 1024,
                "absoluteMaxBytes": 2048,
                "requiredMaxBytes": 1024,
                "maximumSegmentArtifactBytes": maximum,
                "segments": budget_segments,
            },
            "segments": segments,
        }
        path = root / "split-manifest.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return path

    @staticmethod
    def _load(path: Path) -> dict[str, object]:
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def _save(path: Path, manifest: dict[str, object]) -> None:
        path.write_text(json.dumps(manifest), encoding="utf-8")

    def test_rejects_raw_graph_path_normalization_spellings_before_measurement(self) -> None:
        malformed = (
            "nested//segment1.onnx",
            "nested/./segment1.onnx",
            "/segment1.onnx",
            "segment1.onnx/",
            "nested/segment\x1f.onnx",
            "nested/segment\x7f.onnx",
        )
        for value in malformed:
            with self.subTest(value=repr(value)), tempfile.TemporaryDirectory() as tmp:
                manifest_path = self._manifest_with_two_segments(Path(tmp))
                manifest = self._load(manifest_path)
                manifest["segments"][1]["path"] = value
                self._save(manifest_path, manifest)

                with patch.object(verifier, "_measure_file", wraps=verifier._measure_file) as measure:
                    with self.assertRaisesRegex(ValueError, r"unsafe segments\[1\]\.path"):
                        verify_artifact_integrity(manifest_path)
                measure.assert_not_called()

    def test_rejects_raw_external_path_normalization_spellings_before_measurement(self) -> None:
        malformed = (
            "weights//segment1.onnx_data",
            "weights/./segment1.onnx_data",
            "/segment1.onnx_data",
            "segment1.onnx_data/",
            "weights/segment\x00.onnx_data",
            "weights/segment\x7f.onnx_data",
        )
        for value in malformed:
            with self.subTest(value=repr(value)), tempfile.TemporaryDirectory() as tmp:
                manifest_path = self._manifest_with_two_segments(Path(tmp))
                manifest = self._load(manifest_path)
                manifest["segments"][1]["externalData"][0]["location"] = value
                self._save(manifest_path, manifest)

                with patch.object(verifier, "_measure_file", wraps=verifier._measure_file) as measure:
                    with self.assertRaisesRegex(
                        ValueError,
                        r"unsafe segments\[1\]\.externalData\[0\]\.location",
                    ):
                        verify_artifact_integrity(manifest_path)
                measure.assert_not_called()

    def test_accepts_ordinary_nested_forward_slash_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"nested-graph"
            external_payload = b"nested-weights"
            graph_location = "nested/graphs/segment0.onnx"
            external_location = "nested/weights/segment0.onnx_data"
            graph_path = root / graph_location
            external_path = root / external_location
            graph_path.parent.mkdir(parents=True)
            external_path.parent.mkdir(parents=True)
            graph_path.write_bytes(graph_payload)
            external_path.write_bytes(external_payload)
            artifact_bytes = len(graph_payload) + len(external_payload)

            manifest = {
                "schemaVersion": "1.0.0",
                "kind": "unzen-budgeted-multi-segment-onnx",
                "artifactLayout": "per-segment-external-data",
                "splitPlan": {
                    "requiredMaxBytes": 1024,
                    "maximumGeneratedSegmentBytes": artifact_bytes,
                },
                "browserArtifactBudget": {
                    "preferredMaxBytes": 512,
                    "normalMaxBytes": 1024,
                    "absoluteMaxBytes": 2048,
                    "requiredMaxBytes": 1024,
                    "maximumSegmentArtifactBytes": artifact_bytes,
                    "segments": [
                        {"index": 0, "artifactBytes": artifact_bytes, "tier": "preferred"}
                    ],
                },
                "segments": [
                    {
                        "index": 0,
                        "path": graph_location,
                        "sha256": self._sha(graph_payload),
                        "browserArtifactBytes": artifact_bytes,
                        "browserArtifactTier": "preferred",
                        "externalData": [
                            {
                                "location": external_location,
                                "bytes": len(external_payload),
                                "sha256": self._sha(external_payload),
                            }
                        ],
                    }
                ],
            }
            manifest_path = root / "split-manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            report = verify_artifact_integrity(manifest_path)
            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["segments"][0]["path"], graph_location)
            self.assertEqual(
                report["segments"][0]["externalData"][0]["location"],
                external_location,
            )


if __name__ == "__main__":
    unittest.main()
