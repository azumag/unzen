from __future__ import annotations

from contextlib import contextmanager
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


@unittest.skipUnless(
    snapshot.execution_snapshot_paths.generation_bound_cleanup_supported()
    and snapshot._pathname_hard_link_supported(),
    "requires runtime-supported descriptor cleanup and pathname hard links",
)
class ArtifactExecutionSnapshotManifestGenerationTest(unittest.TestCase):
    @staticmethod
    def _entry(path: Path, *, field: str) -> dict[str, object]:
        metadata = os.lstat(path)
        payload = path.read_bytes()
        return {
            "field": field,
            "path": path.name,
            "absolute": path,
            "parts": (path.name,),
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

    def test_manifest_write_stays_on_accepted_generation_without_component_walk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph = root / "segment0.onnx"
            external = root / "segment0.onnx_data"
            graph.write_bytes(b"graph")
            external.write_bytes(b"external")
            manifest = root / "split-manifest.json"
            boundary = (
                {
                    "status": "pass",
                    "manifestSha256": hashlib.sha256(b"{}").hexdigest(),
                    "integrity": {"status": "pass"},
                },
                b"{}",
                (
                    self._entry(graph, field="segments[0].path"),
                    self._entry(
                        external,
                        field="segments[0].externalData[0].location",
                    ),
                ),
            )

            real_opened_root = snapshot._opened_verified_snapshot_root
            moved_snapshot = root / "moved-accepted-snapshot"
            replacement_root: Path | None = None
            replaced = False

            @contextmanager
            def replace_after_root_open(
                snapshot_root: Path,
                expected_root_identity: snapshot.SnapshotWorkspaceIdentity,
            ):
                nonlocal replaced, replacement_root
                with real_opened_root(snapshot_root, expected_root_identity) as root_fd:
                    snapshot_root.rename(moved_snapshot)
                    snapshot_root.mkdir()
                    replacement_root = snapshot_root
                    replaced = True
                    yield root_fd

            with (
                mock.patch.object(snapshot, "_verify_execution_boundary", return_value=boundary),
                mock.patch.object(
                    snapshot.execution_snapshot_paths,
                    "component_walk_supported",
                    return_value=False,
                ),
                mock.patch.object(
                    snapshot,
                    "_opened_verified_snapshot_root",
                    side_effect=replace_after_root_open,
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "workspace changed"):
                    with snapshot.verified_artifact_execution_snapshot(manifest):
                        self.fail("snapshot should not be yielded after workspace replacement")

            self.assertTrue(replaced)
            self.assertTrue(moved_snapshot.exists())
            self.assertEqual((moved_snapshot / manifest.name).read_bytes(), b"{}")
            assert replacement_root is not None
            self.assertTrue(replacement_root.exists())
            self.assertFalse((replacement_root / manifest.name).exists())
            self.assertFalse((replacement_root / graph.name).exists())
            self.assertFalse((replacement_root / external.name).exists())


if __name__ == "__main__":
    unittest.main()
