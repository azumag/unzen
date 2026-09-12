from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from prepare_browser_p0 import PREFERRED_MAX_BYTES, apply_browser_budget  # noqa: E402


class BrowserP0BudgetAtomicityTest(unittest.TestCase):
    def test_later_segment_validation_failure_does_not_partially_annotate_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "segment0.onnx").write_bytes(b"valid")
            manifest = {
                "segments": [
                    {"index": 0, "path": "segment0.onnx", "externalData": []},
                    {"index": 1, "path": "missing.onnx", "externalData": []},
                ]
            }
            before = copy.deepcopy(manifest)

            with self.assertRaisesRegex(RuntimeError, "segment graph path is missing"):
                apply_browser_budget(manifest, root)

            self.assertEqual(manifest, before)

    def test_required_tier_failure_does_not_commit_budget_annotations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            oversized = root / "segment0.onnx"
            with oversized.open("wb") as stream:
                stream.truncate(PREFERRED_MAX_BYTES + 1)
            (root / "segment1.onnx").write_bytes(b"valid")
            manifest = {
                "segments": [
                    {"index": 0, "path": "segment0.onnx", "externalData": []},
                    {"index": 1, "path": "segment1.onnx", "externalData": []},
                ]
            }
            before = copy.deepcopy(manifest)

            with self.assertRaisesRegex(RuntimeError, "browser artifact budget exceeded"):
                apply_browser_budget(manifest, root, require_tier="preferred")

            self.assertEqual(manifest, before)

    def test_success_commits_all_budget_annotations_together(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "segment0.onnx").write_bytes(b"a" * 11)
            (root / "segment1.onnx").write_bytes(b"b" * 13)
            manifest = {
                "segments": [
                    {"index": 0, "path": "segment0.onnx", "externalData": []},
                    {"index": 1, "path": "segment1.onnx", "externalData": []},
                ]
            }

            apply_browser_budget(manifest, root)

            self.assertEqual(manifest["segments"][0]["browserArtifactBytes"], 11)
            self.assertEqual(manifest["segments"][1]["browserArtifactBytes"], 13)
            self.assertEqual(manifest["segments"][0]["browserArtifactTier"], "preferred")
            self.assertEqual(manifest["segments"][1]["browserArtifactTier"], "preferred")
            self.assertEqual(manifest["browserArtifactBudget"]["maximumSegmentArtifactBytes"], 13)


if __name__ == "__main__":
    unittest.main()
