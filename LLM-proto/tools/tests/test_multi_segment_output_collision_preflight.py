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


if __name__ == "__main__":
    unittest.main()
