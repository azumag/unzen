from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
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


@unittest.skipUnless(hasattr(os, "link"), "requires hard-link support")
class LegacyTwoSegmentArtifactExecutionSnapshotTest(unittest.TestCase):
    def _fixture(
        self,
        root: Path,
    ) -> tuple[Path, Path, Path, Path, Path, dict[str, object]]:
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
        return manifest_path, segment0, segment1, external0, external1, manifest

    def test_snapshot_hard_links_manifest_generation_and_cleans_up(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path, segment0, segment1, external0, external1, manifest = self._fixture(root)

            with snapshot.verified_legacy_two_segment_execution_snapshot(
                manifest_path,
                manifest,
                segment0,
                segment1,
            ) as (execution0, execution1):
                execution_root = execution0.parent
                self.assertEqual(os.stat(execution0).st_ino, os.stat(segment0).st_ino)
                self.assertEqual(os.stat(execution1).st_ino, os.stat(segment1).st_ino)
                self.assertEqual(
                    os.stat(execution_root / external0.name).st_ino,
                    os.stat(external0).st_ino,
                )
                self.assertEqual(
                    os.stat(execution_root / external1.name).st_ino,
                    os.stat(external1).st_ino,
                )

            self.assertFalse(execution_root.exists())

    def test_cli_segment_path_must_match_manifest_declaration(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path, segment0, segment1, _, _, manifest = self._fixture(root)
            other = root / "other.onnx"
            other.write_bytes(segment0.read_bytes())

            with self.assertRaisesRegex(
                ValueError,
                "--segment0 does not resolve to manifest segments\\[0\\]\\.path",
            ):
                with snapshot.verified_legacy_two_segment_execution_snapshot(
                    manifest_path,
                    manifest,
                    other,
                    segment1,
                ):
                    self.fail("mismatched CLI segment path must not be yielded")

    def test_same_byte_graph_replacement_before_pin_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path, segment0, segment1, _, _, manifest = self._fixture(root)
            real_link = snapshot._link_verified_file
            replaced = False

            def replace_then_link(entry: dict[str, object], snapshot_root: Path) -> Path:
                nonlocal replaced
                if entry.get("field") == "segments[0].path" and not replaced:
                    replacement = root / "replacement.onnx"
                    replacement.write_bytes(segment0.read_bytes())
                    segment0.unlink()
                    replacement.rename(segment0)
                    replaced = True
                return real_link(entry, snapshot_root)

            with mock.patch.object(
                snapshot,
                "_link_verified_file",
                side_effect=replace_then_link,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "changed after legacy artifact preflight",
                ):
                    with snapshot.verified_legacy_two_segment_execution_snapshot(
                        manifest_path,
                        manifest,
                        segment0,
                        segment1,
                    ):
                        self.fail("replaced segment must not be yielded")

            self.assertTrue(replaced)

    @unittest.skipUnless(os.name == "posix", "requires POSIX ctime mutation semantics")
    def test_same_size_in_place_graph_mutation_with_restored_mtime_before_pin_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path, segment0, segment1, _, _, manifest = self._fixture(root)
            real_link = snapshot._link_verified_file
            mutated = False

            def mutate_then_link(entry: dict[str, object], snapshot_root: Path) -> Path:
                nonlocal mutated
                if entry.get("field") == "segments[0].path" and not mutated:
                    accepted = entry.get("prelinkFingerprint")
                    self.assertIsInstance(accepted, tuple)
                    self.assertEqual(len(accepted), 7)  # type: ignore[arg-type]
                    before = segment0.stat()
                    original = segment0.read_bytes()
                    segment0.write_bytes(b"X" * len(original))
                    os.utime(
                        segment0,
                        ns=(before.st_atime_ns, before.st_mtime_ns),
                    )
                    original_mode = stat.S_IMODE(before.st_mode)
                    os.chmod(segment0, original_mode ^ stat.S_IXUSR)
                    os.chmod(segment0, original_mode)
                    current = segment0.stat()
                    self.assertEqual(current.st_size, accepted[4])  # type: ignore[index]
                    self.assertEqual(current.st_mtime_ns, accepted[5])  # type: ignore[index]
                    self.assertNotEqual(current.st_ctime_ns, accepted[6])  # type: ignore[index]
                    mutated = True
                return real_link(entry, snapshot_root)

            with mock.patch.object(
                snapshot,
                "_link_verified_file",
                side_effect=mutate_then_link,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "changed after legacy artifact preflight",
                ):
                    with snapshot.verified_legacy_two_segment_execution_snapshot(
                        manifest_path,
                        manifest,
                        segment0,
                        segment1,
                    ):
                        self.fail("mutated segment must not be yielded")

            self.assertTrue(mutated)

    def test_in_place_external_mutation_during_execution_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path, segment0, segment1, external0, _, manifest = self._fixture(root)

            with self.assertRaisesRegex(
                RuntimeError,
                "changed during legacy split execution",
            ):
                with snapshot.verified_legacy_two_segment_execution_snapshot(
                    manifest_path,
                    manifest,
                    segment0,
                    segment1,
                ) as (execution0, _execution1):
                    (execution0.parent / external0.name).write_bytes(b"mutated-external")

    def test_workspace_replacement_before_cleanup_is_not_recursively_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path, segment0, segment1, _, _, manifest = self._fixture(root)
            moved_snapshot: Path | None = None
            replacement_marker: Path | None = None

            with self.assertRaisesRegex(
                RuntimeError,
                "legacy artifact execution snapshot workspace changed before cleanup",
            ):
                with snapshot.verified_legacy_two_segment_execution_snapshot(
                    manifest_path,
                    manifest,
                    segment0,
                    segment1,
                ) as (execution0, _execution1):
                    execution_root = execution0.parent
                    moved_snapshot = root / "moved-legacy-artifact-snapshot"
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
