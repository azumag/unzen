from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import artifact_execution_snapshot as snapshot  # noqa: E402


@unittest.skipUnless(hasattr(os, "link"), "requires hard-link support")
class ArtifactExecutionSnapshotTest(unittest.TestCase):
    @staticmethod
    def _entry(path: Path, *, field: str, relative: str) -> dict[str, object]:
        metadata = os.lstat(path)
        payload = path.read_bytes()
        return {
            "field": field,
            "path": relative,
            "absolute": path,
            "parts": tuple(Path(relative).parts),
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "identity": (
                metadata.st_dev,
                metadata.st_ino,
                metadata.st_size,
                metadata.st_mtime_ns,
                metadata.st_ctime_ns,
            ),
            "parentIdentities": (),
        }

    def _boundary(
        self,
        graph: Path,
        external: Path,
        *,
        external_relative: str | None = None,
    ) -> tuple[dict[str, object], bytes, tuple[dict[str, object], ...]]:
        entries = (
            self._entry(graph, field="segments[0].path", relative=graph.name),
            self._entry(
                external,
                field="segments[0].externalData[0].location",
                relative=external_relative or external.name,
            ),
        )
        report = {
            "status": "pass",
            "manifestSha256": hashlib.sha256(b"{}").hexdigest(),
            "integrity": {"status": "pass"},
        }
        return report, b"{}", entries

    def test_snapshot_hard_links_verified_generation_and_cleans_up(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph = root / "segment0.onnx"
            external = root / "segment0.onnx_data"
            graph.write_bytes(b"graph")
            external.write_bytes(b"external")
            boundary = self._boundary(graph, external)
            manifest = root / "split-manifest.json"

            with mock.patch.object(snapshot, "_verify_execution_boundary", return_value=boundary):
                with snapshot.verified_artifact_execution_snapshot(manifest) as (
                    report,
                    execution_manifest,
                ):
                    execution_root = execution_manifest.parent
                    self.assertEqual(report["status"], "pass")
                    self.assertEqual(execution_manifest.read_bytes(), b"{}")
                    self.assertEqual(
                        os.stat(execution_root / graph.name).st_ino,
                        os.stat(graph).st_ino,
                    )
                    self.assertEqual(
                        os.stat(execution_root / external.name).st_ino,
                        os.stat(external).st_ino,
                    )

            self.assertFalse(execution_root.exists())

    def test_same_byte_graph_replacement_before_pin_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph = root / "segment0.onnx"
            external = root / "segment0.onnx_data"
            graph.write_bytes(b"same-graph")
            external.write_bytes(b"external")
            boundary = self._boundary(graph, external)
            manifest = root / "split-manifest.json"
            real_link = snapshot._link_verified_artifact_file
            replaced = False

            def replace_then_link(entry: dict[str, object], destination: Path) -> None:
                nonlocal replaced
                if entry.get("field") == "segments[0].path" and not replaced:
                    replacement = root / "replacement.onnx"
                    replacement.write_bytes(b"same-graph")
                    graph.unlink()
                    replacement.rename(graph)
                    replaced = True
                real_link(entry, destination)

            with (
                mock.patch.object(snapshot, "_verify_execution_boundary", return_value=boundary),
                mock.patch.object(
                    snapshot,
                    "_link_verified_artifact_file",
                    side_effect=replace_then_link,
                ),
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "changed after artifact-snapshot preflight",
                ):
                    with snapshot.verified_artifact_execution_snapshot(manifest):
                        self.fail("snapshot should not be yielded")

            self.assertTrue(replaced)

    def test_same_byte_external_replacement_before_pin_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph = root / "segment0.onnx"
            external = root / "segment0.onnx_data"
            graph.write_bytes(b"graph")
            external.write_bytes(b"same-external")
            boundary = self._boundary(graph, external)
            manifest = root / "split-manifest.json"
            real_link = snapshot._link_verified_artifact_file
            replaced = False

            def replace_then_link(entry: dict[str, object], destination: Path) -> None:
                nonlocal replaced
                if str(entry.get("field")).endswith("externalData[0].location") and not replaced:
                    replacement = root / "replacement.bin"
                    replacement.write_bytes(b"same-external")
                    external.unlink()
                    replacement.rename(external)
                    replaced = True
                real_link(entry, destination)

            with (
                mock.patch.object(snapshot, "_verify_execution_boundary", return_value=boundary),
                mock.patch.object(
                    snapshot,
                    "_link_verified_artifact_file",
                    side_effect=replace_then_link,
                ),
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "changed after artifact-snapshot preflight",
                ):
                    with snapshot.verified_artifact_execution_snapshot(manifest):
                        self.fail("snapshot should not be yielded")

            self.assertTrue(replaced)

    @unittest.skipUnless(
        snapshot._internal_component_walk_supported(),
        "requires dir_fd/O_NOFOLLOW component walking",
    )
    def test_nested_parent_substitution_before_link_is_rolled_back(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph = root / "segment0.onnx"
            external = root / "segment0.onnx_data"
            graph.write_bytes(b"graph")
            external.write_bytes(b"external")
            boundary = self._boundary(
                graph,
                external,
                external_relative="weights/shards/segment0.onnx_data",
            )
            manifest = root / "split-manifest.json"
            outside = root / "outside"
            outside.mkdir()
            detached = root / "detached-internal-parent"
            real_assert = snapshot._assert_accepted_artifact_path
            substituted = False

            def substitute_parent(entry: dict[str, object]) -> None:
                nonlocal substituted
                if (
                    str(entry.get("field")).endswith("externalData[0].location")
                    and not substituted
                ):
                    execution_roots = list(root.glob(".unzen-artifact-execution-*"))
                    self.assertEqual(len(execution_roots), 1)
                    internal_parent = execution_roots[0] / "weights" / "shards"
                    internal_parent.rename(detached)
                    internal_parent.symlink_to(outside, target_is_directory=True)
                    substituted = True
                real_assert(entry)

            with (
                mock.patch.object(snapshot, "_verify_execution_boundary", return_value=boundary),
                mock.patch.object(
                    snapshot,
                    "_assert_accepted_artifact_path",
                    side_effect=substitute_parent,
                ),
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "internal parent changed during pinning",
                ):
                    with snapshot.verified_artifact_execution_snapshot(manifest):
                        self.fail("snapshot should not be yielded")

            self.assertTrue(substituted)
            self.assertFalse((detached / external.name).exists())
            self.assertFalse((outside / external.name).exists())

    def test_in_place_graph_mutation_during_execution_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph = root / "segment0.onnx"
            external = root / "segment0.onnx_data"
            graph.write_bytes(b"graph-a")
            external.write_bytes(b"external")
            boundary = self._boundary(graph, external)
            manifest = root / "split-manifest.json"

            with mock.patch.object(snapshot, "_verify_execution_boundary", return_value=boundary):
                with self.assertRaisesRegex(RuntimeError, "changed during numerical execution"):
                    with snapshot.verified_artifact_execution_snapshot(manifest):
                        graph.write_bytes(b"graph-b")

    def test_in_place_external_mutation_during_execution_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph = root / "segment0.onnx"
            external = root / "segment0.onnx_data"
            graph.write_bytes(b"graph")
            external.write_bytes(b"external-a")
            boundary = self._boundary(graph, external)
            manifest = root / "split-manifest.json"

            with mock.patch.object(snapshot, "_verify_execution_boundary", return_value=boundary):
                with self.assertRaisesRegex(RuntimeError, "changed during numerical execution"):
                    with snapshot.verified_artifact_execution_snapshot(manifest):
                        external.write_bytes(b"external-b")

    def test_workspace_replacement_before_cleanup_is_not_recursively_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph = root / "segment0.onnx"
            external = root / "segment0.onnx_data"
            graph.write_bytes(b"graph")
            external.write_bytes(b"external")
            boundary = self._boundary(graph, external)
            manifest = root / "split-manifest.json"
            moved_snapshot: Path | None = None
            replacement_marker: Path | None = None

            with mock.patch.object(snapshot, "_verify_execution_boundary", return_value=boundary):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "artifact execution snapshot workspace changed",
                ):
                    with snapshot.verified_artifact_execution_snapshot(manifest) as (
                        _,
                        execution_manifest,
                    ):
                        execution_root = execution_manifest.parent
                        moved_snapshot = root / "moved-artifact-snapshot"
                        execution_root.rename(moved_snapshot)
                        execution_root.mkdir()
                        replacement_marker = execution_root / "keep-me.txt"
                        replacement_marker.write_text("replacement", encoding="utf-8")

            assert moved_snapshot is not None
            assert replacement_marker is not None
            self.assertTrue(moved_snapshot.exists())
            self.assertTrue(replacement_marker.exists())
            self.assertEqual(replacement_marker.read_text(encoding="utf-8"), "replacement")


if __name__ == "__main__":
    unittest.main()
