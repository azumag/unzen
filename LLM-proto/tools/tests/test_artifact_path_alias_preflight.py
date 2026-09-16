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

from verify_multi_segment_artifacts import verify_artifact_integrity  # noqa: E402


class ArtifactPathAliasPreflightTest(unittest.TestCase):
    @staticmethod
    def _sha(payload: bytes) -> str:
        return hashlib.sha256(payload).hexdigest()

    def _fixture(self, root: Path) -> Path:
        graph_payloads = [b"graph-zero", b"graph-one"]
        external_payloads = [b"weights-zero", b"weights-one"]
        segments: list[dict[str, object]] = []
        budget_segments: list[dict[str, object]] = []
        maximum = 0

        for index, (graph_payload, external_payload) in enumerate(
            zip(graph_payloads, external_payloads, strict=True)
        ):
            graph_name = f"segment{index}.onnx"
            external_name = f"segment{index}.onnx_data"
            (root / graph_name).write_bytes(graph_payload)
            (root / external_name).write_bytes(external_payload)
            artifact_bytes = len(graph_payload) + len(external_payload)
            maximum = max(maximum, artifact_bytes)
            segments.append(
                {
                    "index": index,
                    "path": graph_name,
                    "sha256": self._sha(graph_payload),
                    "browserArtifactBytes": artifact_bytes,
                    "browserArtifactTier": "preferred",
                    "externalData": [
                        {
                            "location": external_name,
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
        manifest_path = root / "split-manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest_path

    @staticmethod
    def _load(path: Path) -> dict[str, object]:
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def _save(path: Path, manifest: dict[str, object]) -> None:
        path.write_text(json.dumps(manifest), encoding="utf-8")

    def test_normal_per_segment_paths_still_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report = verify_artifact_integrity(self._fixture(Path(tmp)))
            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["segmentCount"], 2)

    def test_rejects_graph_path_reused_by_later_segment(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = self._fixture(Path(tmp))
            manifest = self._load(manifest_path)
            manifest["segments"][1]["path"] = manifest["segments"][0]["path"]
            self._save(manifest_path, manifest)

            with self.assertRaisesRegex(
                ValueError,
                r"duplicate declared artifact path: segments\[1\]\.path aliases segments\[0\]\.path",
            ):
                verify_artifact_integrity(manifest_path)

    def test_rejects_external_path_reused_across_segments(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = self._fixture(Path(tmp))
            manifest = self._load(manifest_path)
            manifest["segments"][1]["externalData"][0]["location"] = (
                manifest["segments"][0]["externalData"][0]["location"]
            )
            self._save(manifest_path, manifest)

            with self.assertRaisesRegex(
                ValueError,
                r"duplicate declared artifact path: segments\[1\]\.externalData\[0\]\.location aliases segments\[0\]\.externalData\[0\]\.location",
            ):
                verify_artifact_integrity(manifest_path)

    def test_rejects_external_path_aliasing_segment_graph(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = self._fixture(Path(tmp))
            manifest = self._load(manifest_path)
            manifest["segments"][0]["externalData"][0]["location"] = manifest["segments"][0]["path"]
            self._save(manifest_path, manifest)

            with self.assertRaisesRegex(
                ValueError,
                r"duplicate declared artifact path: segments\[0\]\.externalData\[0\]\.location aliases segments\[0\]\.path",
            ):
                verify_artifact_integrity(manifest_path)


if __name__ == "__main__":
    unittest.main()
