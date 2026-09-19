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
import legacy_two_segment_artifact_execution_snapshot as snapshot  # noqa: E402


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@unittest.skipUnless(hasattr(os, "link"), "requires hard-link support")
class LegacyTwoSegmentInternalParentSnapshotTest(unittest.TestCase):
    def _fixture(
        self,
        root: Path,
    ) -> tuple[Path, Path, Path, Path, dict[str, object]]:
        segment0 = root / "segment0.onnx"
        segment1 = root / "segment1.onnx"
        external0 = root / "weights" / "shards" / "segment0.onnx_data"
        external1 = root / "segment1.onnx_data"
        manifest_path = root / "split-manifest.json"
        external0.parent.mkdir(parents=True)
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
                            "location": "weights/shards/segment0.onnx_data",
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
        return manifest_path, segment0, segment1, external0, manifest

    def test_nested_external_data_is_pinned_under_snapshot_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path, segment0, segment1, external0, manifest = self._fixture(root)

            with snapshot.verified_legacy_two_segment_execution_snapshot(
                manifest_path,
                manifest,
                segment0,
                segment1,
            ) as (execution0, _execution1):
                execution_root = execution0.parent
                pinned_external = execution_root / "weights" / "shards" / external0.name
                self.assertEqual(os.stat(pinned_external).st_ino, os.stat(external0).st_ino)

            self.assertFalse(execution_root.exists())

    @unittest.skipUnless(
        internal_paths.component_walk_supported(),
        "requires dir_fd/O_NOFOLLOW component walking",
    )
    def test_nested_parent_substitution_before_link_rolls_back_detached_link(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path, segment0, segment1, external0, manifest = self._fixture(root)
            outside = root / "outside"
            outside.mkdir()
            detached = root / "detached-legacy-parent"
            real_assert = snapshot._assert_prelink_fingerprint
            substituted = False

            def substitute_parent(
                requested: Path,
                resolved: Path,
                expected: snapshot.ArtifactFingerprint,
                *,
                label: str,
            ) -> None:
                nonlocal substituted
                if label == "segments[0].externalData[0]" and not substituted:
                    execution_roots = list(root.glob(".unzen-legacy-two-segment-execution-*"))
                    self.assertEqual(len(execution_roots), 1)
                    internal_parent = execution_roots[0] / "weights" / "shards"
                    internal_parent.rename(detached)
                    internal_parent.symlink_to(outside, target_is_directory=True)
                    substituted = True
                real_assert(requested, resolved, expected, label=label)

            with mock.patch.object(
                snapshot,
                "_assert_prelink_fingerprint",
                side_effect=substitute_parent,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "legacy artifact execution snapshot internal parent changed",
                ):
                    with snapshot.verified_legacy_two_segment_execution_snapshot(
                        manifest_path,
                        manifest,
                        segment0,
                        segment1,
                    ):
                        self.fail("substituted internal parent must not be yielded")

            self.assertTrue(substituted)
            self.assertFalse((detached / external0.name).exists())
            self.assertFalse((outside / external0.name).exists())


if __name__ == "__main__":
    unittest.main()
