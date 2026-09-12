from __future__ import annotations

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

from verify_multi_segment_artifacts import _measure_file  # noqa: E402


class VerifyMultiSegmentArtifactDescriptorPinningTest(unittest.TestCase):
    def test_path_replacement_after_open_fails_closed_without_following_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "segment.onnx"
            replacement = root / "replacement.onnx"
            target.write_bytes(b"original-artifact")
            replacement_payload = b"replacement-artifact-is-longer"
            replacement.write_bytes(replacement_payload)

            original_open = Path.open
            replaced = False

            def replace_after_open(path: Path, *args: object, **kwargs: object):
                nonlocal replaced
                handle = original_open(path, *args, **kwargs)
                if path == target and not replaced:
                    os.replace(replacement, target)
                    replaced = True
                return handle

            with patch.object(Path, "open", replace_after_open):
                with self.assertRaisesRegex(RuntimeError, "changed while being measured"):
                    _measure_file(target, chunk_size=4)

            self.assertTrue(replaced)
            self.assertEqual(target.read_bytes(), replacement_payload)

    def test_in_place_mutation_while_hashing_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "segment.onnx_data"
            target.write_bytes(b"abcdefgh")
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
                        with original_open(target, "ab") as writer:
                            writer.write(b"!")
                        self.mutated = True
                    return payload

            def mutating_open(path: Path, *args: object, **kwargs: object):
                handle = original_open(path, *args, **kwargs)
                if path == target and args and args[0] == "rb":
                    return MutatingReader(handle)
                return handle

            with patch.object(Path, "open", mutating_open):
                with self.assertRaisesRegex(RuntimeError, "changed while being measured"):
                    _measure_file(target, chunk_size=4)


if __name__ == "__main__":
    unittest.main()
