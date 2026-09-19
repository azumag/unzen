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

import legacy_two_segment_artifact_execution_snapshot as snapshot  # noqa: E402


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _fixture(root: Path) -> tuple[Path, Path, Path, dict[str, object]]:
    segment0 = root / "segment0.onnx"
    segment1 = root / "segment1.onnx"
    external0 = root / "segment0.onnx_data"
    external1 = root / "segment1.onnx_data"
    manifest_path = root / "split-manifest.json"
    segment0.write_bytes(b"segment-0-graph")
    segment1.write_bytes(b"segment-1-graph")
    external0.write_bytes(b"segment-0-external")
    external1.write_bytes(b"segment-1-external")
    manifest_path.write_text("{}", encoding="utf-8")
    manifest: dict[str, object] = {
        "schemaVersion": "1.0.0",
        "kind": "unzen-real-two-segment-onnx",
        "artifactLayout": "per-segment-external-data",
        "segments": [
            {
                "index": 0,
                "path": segment0.name,
                "sha256": _sha256(segment0),
                "externalData": [
                    {
                        "location": external0.name,
                        "bytes": external0.stat().st_size,
                        "sha256": _sha256(external0),
                    }
                ],
            },
            {
                "index": 1,
                "path": segment1.name,
                "sha256": _sha256(segment1),
                "externalData": [
                    {
                        "location": external1.name,
                        "bytes": external1.stat().st_size,
                        "sha256": _sha256(external1),
                    }
                ],
            },
        ],
    }
    return manifest_path, segment0, segment1, manifest


@unittest.skipUnless(hasattr(os, "link"), "requires hard-link support")
class LegacyTwoSegmentSnapshotWorkspaceIdentityTest(unittest.TestCase):
    def test_replacement_after_workspace_identity_capture_receives_no_links(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path, segment0, segment1, manifest = _fixture(root)
            real_link = snapshot._link_verified_file
            moved_snapshot: Path | None = None
            replacement_root: Path | None = None
            replacement_marker: Path | None = None
            replaced = False

            def replace_then_link(entry: dict[str, object], snapshot_root: Path) -> Path:
                nonlocal moved_snapshot, replacement_root, replacement_marker, replaced
                if not replaced:
                    accepted_identity = entry.get("_snapshotRootIdentity")
                    self.assertIsInstance(accepted_identity, tuple)
                    self.assertEqual(len(accepted_identity), 2)  # type: ignore[arg-type]

                    moved_snapshot = root / "moved-original-legacy-snapshot"
                    snapshot_root.rename(moved_snapshot)
                    snapshot_root.mkdir()
                    replacement_root = snapshot_root
                    replacement_marker = replacement_root / "keep-me.txt"
                    replacement_marker.write_text("replacement", encoding="utf-8")
                    replaced = True
                return real_link(entry, snapshot_root)

            with mock.patch.object(
                snapshot,
                "_link_verified_file",
                side_effect=replace_then_link,
            ):
                with self.assertRaisesRegex(RuntimeError, "workspace changed"):
                    with snapshot.verified_legacy_two_segment_execution_snapshot(
                        manifest_path,
                        manifest,
                        segment0,
                        segment1,
                    ):
                        self.fail("replaced workspace must fail before yielding execution paths")

            self.assertTrue(replaced)
            assert moved_snapshot is not None
            assert replacement_root is not None
            assert replacement_marker is not None
            self.assertTrue(moved_snapshot.is_dir())
            self.assertTrue(replacement_root.is_dir())
            self.assertTrue(replacement_marker.is_file())
            self.assertEqual(replacement_marker.read_text(encoding="utf-8"), "replacement")

            protected_names = {
                "segment0.onnx",
                "segment1.onnx",
                "segment0.onnx_data",
                "segment1.onnx_data",
            }
            self.assertTrue(protected_names.isdisjoint({path.name for path in moved_snapshot.iterdir()}))
            self.assertTrue(
                protected_names.isdisjoint({path.name for path in replacement_root.iterdir()})
            )


if __name__ == "__main__":
    unittest.main()
