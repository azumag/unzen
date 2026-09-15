from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_split_onnx as verify_module  # noqa: E402


class VerifySplitOnnxManifestSnapshotTest(unittest.TestCase):
    def test_loads_plain_manifest_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "split-manifest.json"
            payload = {
                "boundary": {"tensors": [{"name": "hidden_states"}]},
                "logitsOutput": "logits",
            }
            path.write_text(json.dumps(payload), encoding="utf-8")

            self.assertEqual(verify_module._load_manifest_snapshot(path), payload)

    def test_rejects_non_regular_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "split-manifest.json"
            path.mkdir()

            with self.assertRaisesRegex(ValueError, "must be a regular file"):
                verify_module._load_manifest_snapshot(path)

    def test_rejects_manifest_before_creating_onnx_sessions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "split-manifest.json"
            manifest.mkdir()

            with patch.object(verify_module.ort, "InferenceSession") as session:
                with self.assertRaisesRegex(ValueError, "must be a regular file"):
                    verify_module.verify_split(
                        Path("full.onnx"),
                        Path("segment0.onnx"),
                        Path("segment1.onnx"),
                        manifest,
                        [1],
                    )

            session.assert_not_called()

    def test_rejects_path_replacement_between_check_and_open(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "split-manifest.json"
            replacement = root / "replacement.json"
            path.write_text('{"logitsOutput":"original"}', encoding="utf-8")
            replacement.write_text('{"logitsOutput":"replacement"}', encoding="utf-8")
            real_open = os.open
            replaced = False

            def replacing_open(target: object, flags: int, *args: object, **kwargs: object) -> int:
                nonlocal replaced
                if not replaced and Path(target) == path:
                    replaced = True
                    path.unlink()
                    replacement.rename(path)
                return real_open(target, flags, *args, **kwargs)

            with patch.object(verify_module.os, "open", side_effect=replacing_open):
                with self.assertRaisesRegex(RuntimeError, "changed between path check and open"):
                    verify_module._load_manifest_snapshot(path)

    def test_rejects_manifest_mutation_while_reading(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "split-manifest.json"
            path.write_text(
                json.dumps({"padding": "x" * (1024 * 1024 + 32)}),
                encoding="utf-8",
            )
            real_read = os.read
            mutated = False

            def mutating_read(fd: int, size: int) -> bytes:
                nonlocal mutated
                chunk = real_read(fd, size)
                if chunk and not mutated:
                    mutated = True
                    with path.open("ab") as stream:
                        stream.write(b" ")
                return chunk

            with patch.object(verify_module.os, "read", side_effect=mutating_read):
                with self.assertRaisesRegex(RuntimeError, "changed while being read"):
                    verify_module._load_manifest_snapshot(path)


if __name__ == "__main__":
    unittest.main()
