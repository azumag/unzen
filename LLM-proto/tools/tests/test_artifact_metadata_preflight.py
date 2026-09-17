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


class ArtifactMetadataPreflightTest(unittest.TestCase):
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

    def test_valid_metadata_still_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report = verify_artifact_integrity(self._fixture(Path(tmp)))
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["segmentCount"], 2)

    def test_rejects_malformed_later_segment_metadata_before_measurement(self) -> None:
        mutations = (
            (
                "graph sha",
                lambda manifest: manifest["segments"][1].__setitem__("sha256", "not-a-digest"),
                r"segments\[1\]\.sha256 must be a canonical lowercase SHA-256 digest",
            ),
            (
                "external bytes",
                lambda manifest: manifest["segments"][1]["externalData"][0].__setitem__("bytes", True),
                r"segments\[1\]\.externalData\[0\]\.bytes must be a non-negative integer",
            ),
            (
                "external sha",
                lambda manifest: manifest["segments"][1]["externalData"][0].__setitem__(
                    "sha256", "NOT-A-DIGEST"
                ),
                r"segments\[1\]\.externalData\[0\]\.sha256 must be a canonical lowercase SHA-256 digest",
            ),
            (
                "artifact bytes",
                lambda manifest: manifest["segments"][1].__setitem__("browserArtifactBytes", "12"),
                r"segments\[1\]\.browserArtifactBytes must be a non-negative integer",
            ),
            (
                "artifact tier",
                lambda manifest: manifest["segments"][1].__setitem__("browserArtifactTier", ""),
                r"segments\[1\]\.browserArtifactTier must be a non-empty string",
            ),
            (
                "budget entry index",
                lambda manifest: manifest["browserArtifactBudget"]["segments"][1].__setitem__(
                    "index", 0
                ),
                r"browserArtifactBudget\.segments\[1\] index mismatch",
            ),
            (
                "budget entry bytes",
                lambda manifest: manifest["browserArtifactBudget"]["segments"][1].__setitem__(
                    "artifactBytes", False
                ),
                r"browserArtifactBudget\.segments\[1\]\.artifactBytes must be a non-negative integer",
            ),
            (
                "budget entry tier",
                lambda manifest: manifest["browserArtifactBudget"]["segments"][1].__setitem__(
                    "tier", ""
                ),
                r"browserArtifactBudget\.segments\[1\]\.tier must be a non-empty string",
            ),
        )

        for label, mutate, expected_error in mutations:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as tmp:
                manifest_path = self._fixture(Path(tmp))
                manifest = self._load(manifest_path)
                mutate(manifest)
                self._save(manifest_path, manifest)

                with patch.object(verifier, "_measure_file") as measure:
                    with self.assertRaisesRegex(ValueError, expected_error):
                        verify_artifact_integrity(manifest_path)
                measure.assert_not_called()

    def test_rejects_malformed_aggregate_maxima_before_measurement(self) -> None:
        mutations = (
            (
                "budget maximum",
                lambda manifest: manifest["browserArtifactBudget"].__setitem__(
                    "maximumSegmentArtifactBytes", -1
                ),
                r"browserArtifactBudget\.maximumSegmentArtifactBytes must be a non-negative integer",
            ),
            (
                "plan maximum",
                lambda manifest: manifest["splitPlan"].__setitem__(
                    "maximumGeneratedSegmentBytes", True
                ),
                r"splitPlan\.maximumGeneratedSegmentBytes must be a non-negative integer",
            ),
        )

        for label, mutate, expected_error in mutations:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as tmp:
                manifest_path = self._fixture(Path(tmp))
                manifest = self._load(manifest_path)
                mutate(manifest)
                self._save(manifest_path, manifest)

                with patch.object(verifier, "_measure_file") as measure:
                    with self.assertRaisesRegex(ValueError, expected_error):
                        verify_artifact_integrity(manifest_path)
                measure.assert_not_called()


if __name__ == "__main__":
    unittest.main()
