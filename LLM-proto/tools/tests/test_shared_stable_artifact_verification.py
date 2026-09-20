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

import artifact_execution_snapshot as execution_snapshot  # noqa: E402
import verify_multi_segment_artifact_snapshot as snapshot  # noqa: E402


class SharedStableArtifactVerificationTest(unittest.TestCase):
    def _sha(self, payload: bytes) -> str:
        return hashlib.sha256(payload).hexdigest()

    def _fixture(self, root: Path) -> Path:
        graph_payloads = [b"graph-zero", b"graph-one"]
        external_payloads = [b"weights-zero", b"weights-one"]
        segments = []
        budget_segments = []
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
                {
                    "index": index,
                    "artifactBytes": artifact_bytes,
                    "tier": "preferred",
                }
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

    def test_public_and_execution_boundary_share_valid_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)

            public_report = snapshot.verify_artifact_snapshot(manifest_path)
            execution_report, manifest_bytes, entries = (
                execution_snapshot._verify_execution_boundary(manifest_path)
            )

            self.assertEqual(execution_report, public_report)
            self.assertEqual(manifest_bytes, manifest_path.read_bytes())
            self.assertEqual(len(entries), 4)
            self.assertTrue(all("identity" in entry for entry in entries))
            self.assertTrue(all("parentIdentities" in entry for entry in entries))

    def test_same_inode_replacement_is_rejected_identically_through_both_callers(self) -> None:
        def run(caller: object) -> str:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                manifest_path = self._fixture(root)
                graph_path = root / "segment0.onnx"
                real_verify = snapshot.verify_artifact_integrity

                def replace_then_verify(path: Path) -> dict[str, object]:
                    payload = graph_path.read_bytes()
                    replacement = root / "segment0.replacement"
                    replacement.write_bytes(payload)
                    os.replace(replacement, graph_path)
                    return real_verify(path)

                with patch.object(
                    snapshot,
                    "verify_artifact_integrity",
                    side_effect=replace_then_verify,
                ):
                    with self.assertRaises(ValueError) as raised:
                        if caller is snapshot.verify_artifact_snapshot:
                            snapshot.verify_artifact_snapshot(manifest_path)
                        else:
                            execution_snapshot._verify_execution_boundary(manifest_path)
                return str(raised.exception)

        public_error = run(snapshot.verify_artifact_snapshot)
        execution_error = run(execution_snapshot._verify_execution_boundary)
        self.assertEqual(public_error, execution_error)
        self.assertIn(
            "declared artifact changed across artifact integrity verification",
            public_error,
        )

    def test_execution_boundary_delegates_directly_to_shared_core(self) -> None:
        expected = ({"status": "pass"}, b"manifest", ({"identity": (1, 2, 3, 4, 5)},))
        manifest_path = Path("split-manifest.json")
        with patch.object(
            execution_snapshot,
            "_verify_artifact_snapshot_stable",
            return_value=expected,
        ) as shared:
            observed = execution_snapshot._verify_execution_boundary(manifest_path)
        self.assertEqual(observed, expected)
        shared.assert_called_once_with(manifest_path)


if __name__ == "__main__":
    unittest.main()
