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

    def test_verify_multi_split_opens_full_ort_session_from_snapshot_path(self) -> None:
        manifest = {"sourceModel": {}}
        manifest_bytes = json.dumps(manifest).encode("utf-8")
        snapshot_path = Path("snapshot") / "model.onnx"
        segment_path = Path("segment0.onnx")
        opened_paths: list[str] = []

        class FakeSession:
            def __init__(self, path: str, *, providers: list[str]) -> None:
                opened_paths.append(path)

            def run(self, outputs: list[str], feeds: dict[str, object]) -> list[np.ndarray]:
                return [np.asarray([[[0.1, 0.9]]], dtype=np.float32)]

        @contextmanager
        def fake_snapshot(
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
            }, snapshot_path

        artifact_integrity = {
            "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        }
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
            mock.patch.object(verifier, "verify_artifact_integrity", return_value=artifact_integrity),
            mock.patch.object(verifier, "_read_stable_manifest", return_value=manifest_bytes),
            mock.patch.object(verifier, "validate_multi_segment_manifest", return_value=contract),
            mock.patch.object(verifier, "_verified_source_execution_snapshot", side_effect=fake_snapshot),
            mock.patch.object(verifier.ort, "InferenceSession", side_effect=FakeSession),
            mock.patch.object(verifier, "build_feeds", return_value={}),
        ):
            report = verifier.verify_multi_split(
                Path("original.onnx"),
                Path("manifest.json"),
                [1],
            )

        self.assertEqual(opened_paths, [str(snapshot_path), str(segment_path)])
        self.assertEqual(report["status"], "pass")


if __name__ == "__main__":
    unittest.main()
