from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import source_model_execution_snapshot as source_snapshot  # noqa: E402
import verify_multi_segment_onnx as verifier  # noqa: E402


class VerifyMultiSegmentOnnxSourceExecutionSnapshotTest(unittest.TestCase):
    @staticmethod
    def _manifest(
        graph_payload: bytes,
        *,
        external_name: str | None = None,
        external_payload: bytes | None = None,
    ) -> dict[str, object]:
        external: list[dict[str, object]] = []
        if external_name is not None:
            assert external_payload is not None
            external.append(
                {
                    "location": external_name,
                    "bytes": len(external_payload),
                    "sha256": hashlib.sha256(external_payload).hexdigest(),
                }
            )
        return {
            "sourceModel": {
                "sha256": hashlib.sha256(graph_payload).hexdigest(),
                "externalData": external,
            }
        }

    @unittest.skipUnless(hasattr(os, "link"), "requires hard-link support")
    def test_snapshot_pins_stable_symlink_targets_without_copying_payload_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"graph"
            external_payload = b"external"
            graph_target = root / "graph-target.onnx"
            graph_target.write_bytes(graph_payload)
            source = root / "model.onnx"
            source.symlink_to(graph_target.name)
            external_target = root / "weights-target.bin"
            external_target.write_bytes(external_payload)
            external = root / "model.onnx_data"
            external.symlink_to(external_target.name)
            manifest = self._manifest(
                graph_payload,
                external_name=external.name,
                external_payload=external_payload,
            )

            with verifier._verified_source_execution_snapshot(source, manifest) as (
                report,
                snapshot_graph,
            ):
                snapshot_root = snapshot_graph.parent
                snapshot_external = snapshot_root / external.name
                self.assertEqual(report["path"], str(source))
                self.assertEqual(report["graphSha256"], hashlib.sha256(graph_payload).hexdigest())
                self.assertEqual(os.stat(snapshot_graph).st_ino, os.stat(graph_target).st_ino)
                self.assertEqual(os.stat(snapshot_external).st_ino, os.stat(external_target).st_ino)

            self.assertFalse(snapshot_root.exists())

    @unittest.skipUnless(
        hasattr(os, "link") and hasattr(os, "symlink"),
        "requires hard-link and symlink support",
    )
    def test_parent_symlink_retarget_after_workspace_creation_does_not_redirect_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original_parent = root / "original"
            alternate_parent = root / "alternate"
            original_parent.mkdir()
            alternate_parent.mkdir()
            parent_link = root / "source-dir"
            try:
                parent_link.symlink_to(original_parent, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"directory symlinks unavailable in test filesystem: {error}")

            payload = b"same-bytes"
            original_source = original_parent / "model.onnx"
            original_source.write_bytes(payload)
            alternate_source = alternate_parent / "model.onnx"
            alternate_source.write_bytes(payload)
            source = parent_link / "model.onnx"
            manifest = self._manifest(payload)
            real_link = source_snapshot._link_verified_snapshot_file
            retargeted = False

            def retarget_parent_then_link(
                source_path: Path,
                destination_path: Path,
                expected_identity: tuple[int, int],
                *,
                label: str,
            ) -> None:
                nonlocal retargeted
                if label == "source graph" and not retargeted:
                    parent_link.unlink()
                    parent_link.symlink_to(alternate_parent, target_is_directory=True)
                    retargeted = True
                real_link(
                    source_path,
                    destination_path,
                    expected_identity,
                    label=label,
                )

            with mock.patch.object(
                source_snapshot,
                "_link_verified_snapshot_file",
                side_effect=retarget_parent_then_link,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "source graph changed before reference execution",
                ):
                    with verifier._verified_source_execution_snapshot(source, manifest):
                        self.fail("snapshot should not be yielded")

            self.assertTrue(retargeted)
            self.assertEqual(list(original_parent.glob(".unzen-source-execution-*")), [])
            self.assertEqual(list(alternate_parent.glob(".unzen-source-execution-*")), [])

    @unittest.skipUnless(hasattr(os, "link"), "requires hard-link support")
    def test_workspace_replacement_before_cleanup_is_not_recursively_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            payload = b"graph"
            source = root / "model.onnx"
            source.write_bytes(payload)
            manifest = self._manifest(payload)
            moved_snapshot: Path | None = None
            replacement_marker: Path | None = None

            with self.assertRaisesRegex(
                RuntimeError,
                "source execution snapshot workspace changed before cleanup",
            ):
                with verifier._verified_source_execution_snapshot(source, manifest) as (
                    _,
                    snapshot_graph,
                ):
                    snapshot_root = snapshot_graph.parent
                    moved_snapshot = root / "moved-snapshot"
                    snapshot_root.rename(moved_snapshot)
                    snapshot_root.mkdir()
                    replacement_marker = snapshot_root / "keep-me.txt"
                    replacement_marker.write_text("replacement", encoding="utf-8")

            assert moved_snapshot is not None
            assert replacement_marker is not None
            self.assertTrue(moved_snapshot.exists())
            self.assertTrue(replacement_marker.exists())
            self.assertEqual(replacement_marker.read_text(encoding="utf-8"), "replacement")

    @unittest.skipUnless(hasattr(os, "link"), "requires hard-link support")
    def test_same_byte_graph_replacement_before_snapshot_link_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            payload = b"same-bytes"
            source = root / "model.onnx"
            source.write_bytes(payload)
            manifest = self._manifest(payload)
            real_link = source_snapshot._link_verified_snapshot_file
            replaced = False

            def replace_then_link(
                source_path: Path,
                destination_path: Path,
                expected_identity: tuple[int, int],
                *,
                label: str,
            ) -> None:
                nonlocal replaced
                if label == "source graph" and not replaced:
                    replacement = root / "replacement.onnx"
                    replacement.write_bytes(payload)
                    source.unlink()
                    replacement.rename(source)
                    replaced = True
                real_link(
                    source_path,
                    destination_path,
                    expected_identity,
                    label=label,
                )

            with mock.patch.object(
                source_snapshot,
                "_link_verified_snapshot_file",
                side_effect=replace_then_link,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "source graph changed while execution snapshot was being pinned",
                ):
                    with verifier._verified_source_execution_snapshot(source, manifest):
                        self.fail("snapshot should not be yielded")

            self.assertTrue(replaced)

    @unittest.skipUnless(hasattr(os, "link"), "requires hard-link support")
    def test_same_byte_external_replacement_before_snapshot_link_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"graph"
            external_payload = b"same-external-bytes"
            source = root / "model.onnx"
            source.write_bytes(graph_payload)
            external = root / "model.onnx_data"
            external.write_bytes(external_payload)
            manifest = self._manifest(
                graph_payload,
                external_name=external.name,
                external_payload=external_payload,
            )
            real_link = source_snapshot._link_verified_snapshot_file
            replaced = False

            def replace_then_link(
                source_path: Path,
                destination_path: Path,
                expected_identity: tuple[int, int],
                *,
                label: str,
            ) -> None:
                nonlocal replaced
                if label.startswith("source external data") and not replaced:
                    replacement = root / "replacement.bin"
                    replacement.write_bytes(external_payload)
                    external.unlink()
                    replacement.rename(external)
                    replaced = True
                real_link(
                    source_path,
                    destination_path,
                    expected_identity,
                    label=label,
                )

            with mock.patch.object(
                source_snapshot,
                "_link_verified_snapshot_file",
                side_effect=replace_then_link,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "source external data model.onnx_data changed while execution snapshot was being pinned",
                ):
                    with verifier._verified_source_execution_snapshot(source, manifest):
                        self.fail("snapshot should not be yielded")

            self.assertTrue(replaced)

    def test_verify_multi_split_opens_full_and_split_ort_sessions_from_snapshot_paths(self) -> None:
        manifest = {"sourceModel": {}}
        manifest_bytes = json.dumps(manifest).encode("utf-8")
        source_snapshot_path = Path("source-snapshot") / "model.onnx"
        artifact_manifest_path = Path("artifact-snapshot") / "split-manifest.json"
        segment_path = artifact_manifest_path.parent / "segment0.onnx"
        opened_paths: list[str] = []

        class FakeSession:
            def __init__(self, path: str, *, providers: list[str]) -> None:
                opened_paths.append(path)

            def run(self, outputs: list[str], feeds: dict[str, object]) -> list[np.ndarray]:
                return [np.asarray([[[0.1, 0.9]]], dtype=np.float32)]

        @contextmanager
        def fake_source_snapshot(
            full_model_path: Path,
            raw_manifest: dict[str, object],
        ):
            self.assertEqual(full_model_path, Path("original.onnx"))
            self.assertEqual(raw_manifest, manifest)
            yield {
                "path": str(full_model_path),
                "graphBytes": 1,
                "graphSha256": "0" * 64,
                "externalData": [],
                "allExternalDataHashed": True,
            }, source_snapshot_path

        manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
        artifact_integrity = {"manifestSha256": manifest_sha}

        @contextmanager
        def fake_artifact_snapshot(requested_manifest: Path):
            self.assertEqual(requested_manifest, Path("manifest.json"))
            yield {
                "manifestSha256": manifest_sha,
                "integrity": artifact_integrity,
            }, artifact_manifest_path

        contract = {
            "segments": (
                {
                    "index": 0,
                    "startLayer": 0,
                    "endLayer": 1,
                    "path": segment_path,
                    "inputs": (),
                    "outputs": ("logits",),
                },
            ),
            "boundaries": (),
            "logitsOutput": "logits",
        }

        with (
            mock.patch.object(
                verifier,
                "_verified_artifact_execution_snapshot",
                side_effect=fake_artifact_snapshot,
            ),
            mock.patch.object(verifier, "_read_stable_manifest", return_value=manifest_bytes),
            mock.patch.object(verifier, "validate_multi_segment_manifest", return_value=contract),
            mock.patch.object(
                verifier,
                "_verified_source_execution_snapshot",
                side_effect=fake_source_snapshot,
            ),
            mock.patch.object(verifier.ort, "InferenceSession", side_effect=FakeSession),
            mock.patch.object(verifier, "build_feeds", return_value={}),
        ):
            report = verifier.verify_multi_split(
                Path("original.onnx"),
                Path("manifest.json"),
                [1],
            )

        self.assertEqual(opened_paths, [str(source_snapshot_path), str(segment_path)])
        self.assertEqual(report["status"], "pass")


if __name__ == "__main__":
    unittest.main()
