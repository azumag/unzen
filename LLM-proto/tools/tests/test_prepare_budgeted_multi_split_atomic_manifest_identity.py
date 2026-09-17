from __future__ import annotations

import json
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

import prepare_budgeted_multi_split_atomic as atomic  # noqa: E402


def make_manifest() -> dict[str, object]:
    return {
        "sourceModel": {"path": "model.onnx", "externalData": []},
        "segments": [
            {
                "index": 0,
                "path": "segment0.onnx",
                "externalData": [{"location": "segment0.onnx_data"}],
            }
        ],
    }


def write_staged(staged: Path) -> None:
    (staged / "segment0.onnx").write_bytes(b"new-graph")
    (staged / "segment0.onnx_data").write_bytes(b"new-weights")
    (staged / "split-manifest.json").write_text(
        json.dumps(make_manifest()) + "\n",
        encoding="utf-8",
    )


class StagedManifestIdentityTest(unittest.TestCase):
    def test_path_replacement_during_descriptor_snapshot_is_rejected_before_invalidation(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            staged = root / "staged"
            output = root / "output"
            staged.mkdir()
            output.mkdir()
            write_staged(staged)
            previous = output / "split-manifest.json"
            previous.write_text("old-manifest\n", encoding="utf-8")

            real_read = os.read
            real_replace = os.replace
            replaced = False

            def replacing_read(fd: int, count: int) -> bytes:
                nonlocal replaced
                block = real_read(fd, count)
                if block and not replaced:
                    replaced = True
                    replacement = staged / "replacement.json"
                    replacement.write_text("{}\n", encoding="utf-8")
                    real_replace(replacement, staged / "split-manifest.json")
                return block

            with mock.patch.object(atomic.os, "read", side_effect=replacing_read):
                with self.assertRaisesRegex(RuntimeError, r"changed during snapshot read"):
                    atomic._publish_staged_split(
                        staged_dir=staged,
                        output_dir=output,
                        source_model_path=source,
                        manifest=make_manifest(),
                    )

            self.assertEqual(previous.read_text(encoding="utf-8"), "old-manifest\n")
            self.assertFalse((output / "segment0.onnx").exists())
            self.assertFalse((output / "segment0.onnx_data").exists())

    def test_manifest_replacement_after_validation_fails_closed_before_commit_marker_publish(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            staged = root / "staged"
            output = root / "output"
            staged.mkdir()
            output.mkdir()
            write_staged(staged)
            (output / "segment0.onnx").write_bytes(b"old-graph")
            (output / "segment0.onnx_data").write_bytes(b"old-weights")
            (output / "split-manifest.json").write_text("old-manifest\n", encoding="utf-8")

            real_replace = os.replace
            replaced = False

            def replacing_after_graph(
                src: os.PathLike[str] | str,
                dst: os.PathLike[str] | str,
            ) -> None:
                nonlocal replaced
                src_path = Path(src)
                dst_path = Path(dst)
                real_replace(src_path, dst_path)
                if dst_path.name == "segment0.onnx" and not replaced:
                    replaced = True
                    replacement = staged / "replacement.json"
                    replacement.write_text("{}\n", encoding="utf-8")
                    real_replace(replacement, staged / "split-manifest.json")

            with mock.patch.object(atomic.os, "replace", side_effect=replacing_after_graph):
                with self.assertRaisesRegex(
                    RuntimeError,
                    r"changed after validation and before publication",
                ):
                    atomic._publish_staged_split(
                        staged_dir=staged,
                        output_dir=output,
                        source_model_path=source,
                        manifest=make_manifest(),
                    )

            self.assertFalse((output / "split-manifest.json").exists())
            self.assertEqual((output / "segment0.onnx").read_bytes(), b"new-graph")
            self.assertEqual((output / "segment0.onnx_data").read_bytes(), b"new-weights")


if __name__ == "__main__":
    unittest.main()
