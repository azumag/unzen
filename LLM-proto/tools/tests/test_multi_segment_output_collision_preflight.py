from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from multi_segment_onnx import (  # noqa: E402
    _generated_artifact_paths,
    _preflight_generated_artifact_collisions,
    _preflight_generated_artifact_destinations,
)


class MultiSegmentOutputCollisionPreflightTest(unittest.TestCase):
    def test_rejects_existing_hard_link_to_source_before_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model_q4.onnx"
            source.write_bytes(b"source-graph-bytes")
            generated = root / "segment0.onnx"
            os.link(source, generated)
            before = source.read_bytes()

            with self.assertRaisesRegex(ValueError, "overwrite source data"):
                _preflight_generated_artifact_collisions(
                    {source},
                    _generated_artifact_paths(root, 1),
                )

            self.assertEqual(source.read_bytes(), before)
            self.assertTrue(generated.samefile(source))

    def test_manifest_destination_is_preflighted_before_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "split-manifest.json"
            source.write_bytes(b"source-external-data")
            before = source.read_bytes()
            generated = _generated_artifact_paths(root, 1)

            self.assertIn(source, generated)
            with self.assertRaisesRegex(ValueError, "overwrite source data"):
                _preflight_generated_artifact_collisions({source}, generated)

            self.assertEqual(source.read_bytes(), before)

    def test_destination_preflight_allows_missing_and_single_link_regular_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            generated = _generated_artifact_paths(root, 1)
            (root / "segment0.onnx").write_bytes(b"replaceable")

            _preflight_generated_artifact_destinations(generated)

            self.assertEqual((root / "segment0.onnx").read_bytes(), b"replaceable")
            self.assertFalse((root / "segment0.onnx_data").exists())
            self.assertFalse((root / "split-manifest.json").exists())

    def test_destination_preflight_rejects_symlink_without_mutating_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "unrelated.bin"
            target.write_bytes(b"keep-me")
            generated = root / "segment0.onnx"
            try:
                generated.symlink_to(target)
            except OSError as error:
                self.skipTest(f"symlinks unavailable on this platform: {error}")
            before = target.read_bytes()

            with self.assertRaisesRegex(ValueError, "must not be a symlink"):
                _preflight_generated_artifact_destinations(
                    _generated_artifact_paths(root, 1)
                )

            self.assertEqual(target.read_bytes(), before)
            self.assertTrue(generated.is_symlink())

    def test_destination_preflight_rejects_unrelated_hard_link_before_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "unrelated.bin"
            target.write_bytes(b"keep-me")
            generated = root / "segment0.onnx"
            os.link(target, generated)
            before = target.read_bytes()

            with self.assertRaisesRegex(ValueError, "exactly one hard link"):
                _preflight_generated_artifact_destinations(
                    _generated_artifact_paths(root, 1)
                )

            self.assertEqual(target.read_bytes(), before)
            self.assertTrue(generated.samefile(target))

    def test_destination_preflight_rejects_non_regular_destination(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            generated = root / "segment0.onnx"
            generated.mkdir()

            with self.assertRaisesRegex(ValueError, "must be a regular file"):
                _preflight_generated_artifact_destinations(
                    _generated_artifact_paths(root, 1)
                )

            self.assertTrue(generated.is_dir())


if __name__ == "__main__":
    unittest.main()
