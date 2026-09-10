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


class VerifyMultiSegmentArtifactSnapshotTest(unittest.TestCase):
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

    def _symlink_or_skip(self, link: Path, target: Path) -> None:
        try:
            link.symlink_to(target)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"symlink creation is unavailable: {error}")

    def test_valid_snapshot_binds_underlying_integrity_to_same_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)

            report = snapshot_module.verify_artifact_snapshot(manifest_path)

            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["decisionStatus"], "diagnostic-only")
            self.assertEqual(report["segmentCount"], 2)
            self.assertEqual(report["artifactFileCount"], 4)
            self.assertEqual(
                report["manifestSha256"],
                hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                report["manifestSha256"], report["integrity"]["manifestSha256"]
            )

    def test_rejects_manifest_final_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            real_manifest = root / "real-manifest.json"
            manifest_path.replace(real_manifest)
            self._symlink_or_skip(manifest_path, real_manifest)

            with self.assertRaisesRegex(ValueError, "split manifest must not be a symlink"):
                snapshot_module.verify_artifact_snapshot(manifest_path)

    def test_rejects_graph_final_symlink_even_when_content_matches(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            graph_path = root / "segment0.onnx"
            real_graph = root / "segment0-real.onnx"
            graph_path.replace(real_graph)
            self._symlink_or_skip(graph_path, real_graph)

            with self.assertRaisesRegex(ValueError, r"segments\[0\]\.path must not be a symlink"):
                snapshot_module.verify_artifact_snapshot(manifest_path)

    def test_rejects_external_data_final_symlink_even_when_content_matches(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            data_path = root / "segment1.onnx_data"
            real_data = root / "segment1-real.onnx_data"
            data_path.replace(real_data)
            self._symlink_or_skip(data_path, real_data)

            with self.assertRaisesRegex(
                ValueError, r"segments\[1\]\.externalData\[0\]\.location must not be a symlink"
            ):
                snapshot_module.verify_artifact_snapshot(manifest_path)

    def test_rejects_same_content_inode_replacement_during_underlying_verifier(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            graph_path = root / "segment0.onnx"
            real_verify = snapshot_module.verify_artifact_integrity

            def replace_then_verify(path: Path) -> dict[str, object]:
                payload = graph_path.read_bytes()
                replacement = root / "segment0.replacement"
                replacement.write_bytes(payload)
                os.replace(replacement, graph_path)
                return real_verify(path)

            with patch.object(
                snapshot_module,
                "verify_artifact_integrity",
                side_effect=replace_then_verify,
            ):
                with self.assertRaisesRegex(
                    ValueError, "declared artifact changed across artifact integrity verification"
                ):
                    snapshot_module.verify_artifact_snapshot(manifest_path)

    def test_rejects_manifest_inode_replacement_during_underlying_verifier(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            real_verify = snapshot_module.verify_artifact_integrity

            def replace_then_verify(path: Path) -> dict[str, object]:
                payload = manifest_path.read_bytes()
                replacement = root / "manifest.replacement"
                replacement.write_bytes(payload)
                os.replace(replacement, manifest_path)
                return real_verify(path)

            with patch.object(
                snapshot_module,
                "verify_artifact_integrity",
                side_effect=replace_then_verify,
            ):
                with self.assertRaisesRegex(
                    ValueError, "split manifest changed across artifact integrity verification"
                ):
                    snapshot_module.verify_artifact_snapshot(manifest_path)


if __name__ == "__main__":
    unittest.main()
