from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_browser_p0 as p0_module  # noqa: E402
from prepare_browser_p0 import (  # noqa: E402
    ABSOLUTE_MAX_BYTES,
    NORMAL_MAX_BYTES,
    PREFERRED_MAX_BYTES,
    SOURCE_EXTERNAL_DATA_BYTES,
    SOURCE_EXTERNAL_DATA_LOCATION,
    SOURCE_EXTERNAL_DATA_SHA256,
    SOURCE_GRAPH_SHA256,
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

    def test_p0_source_graph_must_match_pinned_digest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "model_q4.onnx"
            source.write_bytes(b"not-the-pinned-smollm2-graph")
            with self.assertRaisesRegex(RuntimeError, "does not match the pinned artifact"):
                p0_module.verify_pinned_source_graph(source)


    def test_p0_external_data_must_match_pinned_digest(self) -> None:
        manifest = {
            "sourceModel": {
                "externalData": [{
                    "location": SOURCE_EXTERNAL_DATA_LOCATION,
                    "bytes": SOURCE_EXTERNAL_DATA_BYTES,
                    "sha256": "0" * 64,
                }]
            }
        }
        with self.assertRaisesRegex(RuntimeError, "external data does not match"):
            p0_module.verify_pinned_source_external_data(manifest)

    def test_prepare_records_pinned_revision_and_source_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model_q4.onnx"
            source.write_bytes(b"fixture")
            output = root / "split"
            output.mkdir()
            (output / "segment0.onnx").write_bytes(b"segment-0")
            (output / "segment1.onnx").write_bytes(b"segment-1")
            manifest = {
                "sourceModel": {
                    "sha256": SOURCE_GRAPH_SHA256,
                    "externalData": [{
                        "location": SOURCE_EXTERNAL_DATA_LOCATION,
                        "bytes": SOURCE_EXTERNAL_DATA_BYTES,
                        "sha256": SOURCE_EXTERNAL_DATA_SHA256,
                    }],
                },
                "segments": [
                    {"index": 0, "path": "segment0.onnx", "externalData": []},
                    {"index": 1, "path": "segment1.onnx", "externalData": []},
                ],
            }
            with (
                patch.object(p0_module, "verify_pinned_source_graph", return_value=SOURCE_GRAPH_SHA256),
                patch.object(p0_module, "prepare_real_split", return_value=manifest),
            ):
                prepared = p0_module.prepare_browser_p0(source, output)

            self.assertEqual(prepared["sourceModel"]["sha256"], SOURCE_GRAPH_SHA256)
            self.assertEqual(prepared["modelProfile"]["revision"], p0_module.MODEL_REVISION)
            self.assertEqual(prepared["modelProfile"]["modelId"], p0_module.MODEL_ID)


if __name__ == "__main__":
    unittest.main()
