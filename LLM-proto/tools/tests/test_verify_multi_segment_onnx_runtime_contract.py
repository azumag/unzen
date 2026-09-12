from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from verify_multi_segment_onnx import (  # noqa: E402
    validate_multi_segment_manifest,
    verify_source_model_identity,
)


class VerifyMultiSegmentOnnxRuntimeContractTest(unittest.TestCase):
    def _manifest(self, root: Path) -> dict[str, object]:
        (root / "segment0.onnx").write_bytes(b"segment-zero")
        (root / "segment1.onnx").write_bytes(b"segment-one")
        return {
            "kind": "unzen-budgeted-multi-segment-onnx",
            "artifactLayout": "per-segment-external-data",
            "segments": [
                {
                    "index": 0,
                    "startLayer": 0,
                    "endLayer": 1,
                    "path": "segment0.onnx",
                    "inputs": ["input_ids"],
                    "outputs": ["hidden"],
                },
                {
                    "index": 1,
                    "startLayer": 1,
                    "endLayer": 2,
                    "path": "segment1.onnx",
                    "inputs": ["hidden"],
                    "outputs": ["logits"],
                },
            ],
            "boundaries": [
                {
                    "afterLayer": 0,
                    "beforeLayer": 1,
                    "tensors": [{"name": "hidden"}],
                }
            ],
            "splitPlan": {"cutLayers": [1]},
        }

    def test_rejects_coercible_segment_and_cut_values(self) -> None:
        cases = [
            (lambda manifest: manifest["segments"][0].__setitem__("index", "0"), r"segments\[0\]\.index"),
            (lambda manifest: manifest["segments"][0].__setitem__("startLayer", 0.0), r"segments\[0\]\.startLayer"),
            (lambda manifest: manifest["segments"][0].__setitem__("inputs", [123]), r"segments\[0\]\.inputs\[0\]"),
            (lambda manifest: manifest["boundaries"][0]["tensors"][0].__setitem__("name", 123), r"tensors\[0\]\.name"),
            (lambda manifest: manifest["splitPlan"].__setitem__("cutLayers", ["1"]), r"splitPlan\.cutLayers\[0\]"),
        ]
        for mutate, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                manifest = self._manifest(root)
                mutate(manifest)
                with self.assertRaisesRegex(ValueError, message):
                    validate_multi_segment_manifest(manifest, root)

    def test_source_identity_rejects_coercible_runtime_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_payload = b"source-graph"
            source = root / "model.onnx"
            source.write_bytes(source_payload)
            weights_payload = b"external-weights"
            weights = root / "model.onnx_data"
            weights.write_bytes(weights_payload)
            manifest = {
                "sourceModel": {
                    "sha256": hashlib.sha256(source_payload).hexdigest(),
                    "externalData": [
                        {
                            "location": weights.name,
                            "bytes": str(len(weights_payload)),
                            "sha256": hashlib.sha256(weights_payload).hexdigest(),
                        }
                    ],
                }
            }

            with self.assertRaisesRegex(ValueError, r"externalData\[0\]\.bytes"):
                verify_source_model_identity(source, manifest)

            manifest["sourceModel"]["externalData"][0]["bytes"] = len(weights_payload)
            manifest["sourceModel"]["externalData"][0]["location"] = 123
            with self.assertRaisesRegex(ValueError, r"externalData\[0\]\.location"):
                verify_source_model_identity(source, manifest)

            manifest["sourceModel"]["sha256"] = 123
            with self.assertRaisesRegex(ValueError, r"sourceModel\.sha256"):
                verify_source_model_identity(source, manifest)

    def test_source_graph_path_replacement_does_not_mix_file_identities(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            replacement = root / "replacement.onnx"
            original_payload = b"original-source-graph"
            replacement_payload = b"replacement-source-graph-is-different"
            source.write_bytes(original_payload)
            replacement.write_bytes(replacement_payload)
            manifest = {
                "sourceModel": {
                    "sha256": hashlib.sha256(original_payload).hexdigest(),
                    "externalData": [],
                }
            }
            original_open = Path.open
            replaced = False

            def replace_after_open(path: Path, *args: object, **kwargs: object):
                nonlocal replaced
                handle = original_open(path, *args, **kwargs)
                if path == source and not replaced:
                    os.replace(replacement, source)
                    replaced = True
                return handle

            with patch.object(Path, "open", replace_after_open):
                report = verify_source_model_identity(source, manifest)

            self.assertTrue(replaced)
            self.assertEqual(source.read_bytes(), replacement_payload)
            self.assertEqual(report["graphBytes"], len(original_payload))
            self.assertEqual(report["graphSha256"], hashlib.sha256(original_payload).hexdigest())

    def test_source_graph_in_place_mutation_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            original_payload = b"abcdefgh"
            source.write_bytes(original_payload)
            manifest = {
                "sourceModel": {
                    "sha256": hashlib.sha256(original_payload).hexdigest(),
                    "externalData": [],
                }
            }
            original_open = Path.open

            class MutatingReader:
                def __init__(self, handle):
                    self.handle = handle
                    self.mutated = False

                def __enter__(self):
                    return self

                def __exit__(self, exc_type, exc, tb):
                    self.handle.close()
                    return False

                def fileno(self) -> int:
                    return self.handle.fileno()

                def read(self, size: int = -1) -> bytes:
                    payload = self.handle.read(size)
                    if payload and not self.mutated:
                        with original_open(source, "ab") as writer:
                            writer.write(b"!")
                        self.mutated = True
                    return payload

            def mutating_open(path: Path, *args: object, **kwargs: object):
                handle = original_open(path, *args, **kwargs)
                if path == source and args and args[0] == "rb":
                    return MutatingReader(handle)
                return handle

            with patch.object(Path, "open", mutating_open):
                with self.assertRaisesRegex(RuntimeError, "changed while being measured"):
                    verify_source_model_identity(source, manifest)


if __name__ == "__main__":
    unittest.main()
