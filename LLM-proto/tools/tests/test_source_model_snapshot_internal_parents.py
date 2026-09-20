from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import execution_snapshot_internal_paths as internal_paths  # noqa: E402
import source_model_execution_snapshot as snapshot  # noqa: E402


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


@unittest.skipUnless(hasattr(os, "link"), "requires hard-link support")
class SourceModelInternalParentSnapshotTest(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[Path, Path, dict[str, object]]:
        graph_payload = b"source-graph"
        external_payload = b"source-external"
        graph = root / "model.onnx"
        external = root / "weights" / "shards" / "model.onnx_data"
        external.parent.mkdir(parents=True)
        graph.write_bytes(graph_payload)
        external.write_bytes(external_payload)
        manifest: dict[str, object] = {
            "sourceModel": {
                "sha256": _sha256(graph_payload),
                "externalData": [
                    {
                        "location": "weights/shards/model.onnx_data",
                        "bytes": len(external_payload),
                        "sha256": _sha256(external_payload),
                    }
                ],
            }
        }
        return graph, external, manifest

    def test_nested_external_data_is_pinned_under_snapshot_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph, external, manifest = self._fixture(root)

            with snapshot.verified_source_execution_snapshot(graph, manifest) as (
                _report,
                snapshot_graph,
            ):
                snapshot_root = snapshot_graph.parent
                pinned_external = snapshot_root / "weights" / "shards" / external.name
                self.assertEqual(os.stat(pinned_external).st_ino, os.stat(external).st_ino)

            self.assertFalse(snapshot_root.exists())

    def test_pathname_fallback_does_not_require_nofollow_stat(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph, external, manifest = self._fixture(root)
            real_stat = os.stat

            def reject_pathname_nofollow_stat(path, *args, **kwargs):
                if kwargs.get("follow_symlinks") is False and kwargs.get("dir_fd") is None:
                    raise AssertionError("pathname fallback must use lstat metadata")
                return real_stat(path, *args, **kwargs)

            with (
                mock.patch.object(internal_paths, "component_walk_supported", return_value=False),
                mock.patch.object(internal_paths, "nofollow_hardlink_supported", return_value=True),
                mock.patch.object(snapshot.os, "stat", side_effect=reject_pathname_nofollow_stat),
            ):
                with snapshot.verified_source_execution_snapshot(graph, manifest) as (
                    _report,
                    snapshot_graph,
                ):
                    snapshot_root = snapshot_graph.parent
                    pinned_external = snapshot_root / "weights" / "shards" / external.name
                    self.assertEqual(os.lstat(pinned_external).st_ino, os.lstat(external).st_ino)

            self.assertFalse(snapshot_root.exists())

    @unittest.skipUnless(
        internal_paths.component_walk_supported(),
        "requires dir_fd/O_NOFOLLOW component walking",
    )
    def test_nested_parent_substitution_before_link_rolls_back_detached_link(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph, external, manifest = self._fixture(root)
            outside = root / "outside"
            outside.mkdir()
            detached = root / "detached-source-parent"
            real_assert = snapshot._assert_source_link_identity
            substituted = False

            def substitute_parent(
                source_path: Path,
                expected_identity: tuple[int, int],
                *,
                label: str,
            ) -> None:
                nonlocal substituted
                if label.startswith("source external data") and not substituted:
                    execution_roots = list(root.glob(".unzen-source-execution-*"))
                    self.assertEqual(len(execution_roots), 1)
                    internal_parent = execution_roots[0] / "weights" / "shards"
                    internal_parent.rename(detached)
                    internal_parent.symlink_to(outside, target_is_directory=True)
                    substituted = True
                real_assert(source_path, expected_identity, label=label)

            with mock.patch.object(
                snapshot,
                "_assert_source_link_identity",
                side_effect=substitute_parent,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "source execution snapshot internal parent changed",
                ):
                    with snapshot.verified_source_execution_snapshot(graph, manifest):
                        self.fail("substituted internal parent must not be yielded")

            self.assertTrue(substituted)
            self.assertFalse((detached / external.name).exists())
            self.assertFalse((outside / external.name).exists())


if __name__ == "__main__":
    unittest.main()
