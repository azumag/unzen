from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_artifact_snapshot as snapshot_module  # noqa: E402


class ArtifactSnapshotHardlinkAliasTest(unittest.TestCase):
    def _sha(self, payload: bytes) -> str:
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
                "requiredMaxBytes": 512,
                "maximumGeneratedSegmentBytes": maximum,
            },
            "browserArtifactBudget": {
                "preferredMaxBytes": 512,
                "normalMaxBytes": 1024,
                "absoluteMaxBytes": 2048,
                "requiredMaxBytes": 512,
                "maximumSegmentArtifactBytes": maximum,
                "segments": budget_segments,
            },
            "segments": segments,
        }
        manifest_path = root / "split-manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest_path

    def _replace_with_hardlink_or_skip(self, source: Path, destination: Path) -> None:
        try:
            destination.unlink()
            os.link(source, destination)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"hard-link creation is unavailable: {error}")

    def _assert_rejected_before_hashing_or_integrity(self, manifest_path: Path) -> None:
        with (
            patch.object(snapshot_module, "_measure") as measure,
            patch.object(snapshot_module, "verify_artifact_integrity") as integrity,
        ):
            with self.assertRaisesRegex(
                ValueError,
                "duplicate declared artifact file identity",
            ):
                snapshot_module.verify_artifact_snapshot(manifest_path)
        measure.assert_not_called()
        integrity.assert_not_called()

    def test_rejects_graph_to_graph_hardlink_alias_before_hashing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            self._replace_with_hardlink_or_skip(
                root / "segment0.onnx",
                root / "segment1.onnx",
            )

            self._assert_rejected_before_hashing_or_integrity(manifest_path)

    def test_rejects_graph_to_external_hardlink_alias_before_hashing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            self._replace_with_hardlink_or_skip(
                root / "segment0.onnx",
                root / "segment0.onnx_data",
            )

            self._assert_rejected_before_hashing_or_integrity(manifest_path)


if __name__ == "__main__":
    unittest.main()
