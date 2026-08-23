from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from prepare_browser_p0 import (  # noqa: E402
    ABSOLUTE_MAX_BYTES,
    NORMAL_MAX_BYTES,
    PREFERRED_MAX_BYTES,
    TARGET_BYTES,
    apply_browser_budget,
)


class BrowserP0BudgetTest(unittest.TestCase):
    def _manifest(self, directory: Path, sizes: tuple[int, int]) -> dict[str, object]:
        segments = []
        for index, size in enumerate(sizes):
            graph_name = f"segment{index}.onnx"
            (directory / graph_name).write_bytes(b"g" * size)
            segments.append({
                "index": index,
                "path": graph_name,
                "externalData": [],
            })
        return {"segments": segments}

    def test_preferred_budget_is_encoded_and_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = self._manifest(root, (1024, 2048))
            apply_browser_budget(manifest, root)
            budget = manifest["browserArtifactBudget"]
            self.assertEqual(budget["targetBytes"], TARGET_BYTES)
            self.assertEqual(budget["preferredMaxBytes"], PREFERRED_MAX_BYTES)
            self.assertEqual(budget["normalMaxBytes"], NORMAL_MAX_BYTES)
            self.assertEqual(budget["absoluteMaxBytes"], ABSOLUTE_MAX_BYTES)
            self.assertEqual([item["tier"] for item in budget["segments"]], ["preferred", "preferred"])

    def test_p0_fails_instead_of_silently_accepting_an_oversized_shard(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Avoid allocating hundreds of MiB: sparse truncate still reports the
            # real file size used by the production budget check.
            for index, size in enumerate((PREFERRED_MAX_BYTES + 1, 1024)):
                path = root / f"segment{index}.onnx"
                with path.open("wb") as stream:
                    stream.truncate(size)
            manifest = {
                "segments": [
                    {"index": 0, "path": "segment0.onnx", "externalData": []},
                    {"index": 1, "path": "segment1.onnx", "externalData": []},
                ]
            }
            with self.assertRaisesRegex(RuntimeError, "increase segment count"):
                apply_browser_budget(manifest, root, require_tier="preferred")


if __name__ == "__main__":
    unittest.main()
