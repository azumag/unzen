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

    def _nest_segment(self, root: Path, manifest_path: Path, index: int = 0) -> Path:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        segment = manifest["segments"][index]
        nested = root / f"segment{index}-files"
        nested.mkdir()

        graph_name = segment["path"]
        (root / graph_name).rename(nested / graph_name)
        segment["path"] = f"{nested.name}/{graph_name}"

        for external in segment["externalData"]:
            external_name = external["location"]
            (root / external_name).rename(nested / external_name)
            external["location"] = f"{nested.name}/{external_name}"

        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return nested

    def _symlink_or_skip(self, link: Path, target: Path) -> None:
        try:
            link.symlink_to(target)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f"symlink creation is unavailable: {error}")

    def _require_component_walk(self) -> None:
        if not snapshot_module._component_walk_supported():
            self.skipTest("dir_fd + O_NOFOLLOW component walking is unavailable")

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
            expected_mode = (
                snapshot_module.PATH_RESOLUTION_COMPONENT_ANCHORED
                if snapshot_module._component_walk_supported()
                else snapshot_module.PATH_RESOLUTION_FINAL_ONLY
            )
            self.assertEqual(report["pathResolutionMode"], expected_mode)

    def test_reports_portable_final_component_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)

            with patch.object(snapshot_module, "_component_walk_supported", return_value=False):
                report = snapshot_module.verify_artifact_snapshot(manifest_path)

            self.assertEqual(
                report["pathResolutionMode"],
                snapshot_module.PATH_RESOLUTION_FINAL_ONLY,
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

    def test_rejects_intermediate_directory_symlink(self) -> None:
        self._require_component_walk()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            nested = self._nest_segment(root, manifest_path)
            real_nested = root / "segment0-files-real"
            nested.rename(real_nested)
            self._symlink_or_skip(nested, real_nested)

            with self.assertRaisesRegex(
                ValueError,
                r"segments\[0\]\.path parent component must not be a symlink",
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

    def test_rejects_same_file_instances_under_replaced_parent_directory(self) -> None:
        self._require_component_walk()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            nested = self._nest_segment(root, manifest_path)
            real_verify = snapshot_module.verify_artifact_integrity

            def replace_parent_then_verify(path: Path) -> dict[str, object]:
                old_nested = root / "segment0-files-old"
                nested.rename(old_nested)
                nested.mkdir()
                for old_file in old_nested.iterdir():
                    os.link(old_file, nested / old_file.name)
                return real_verify(path)

            with patch.object(
                snapshot_module,
                "verify_artifact_integrity",
                side_effect=replace_parent_then_verify,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "declared artifact parent directory changed across artifact integrity verification",
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
