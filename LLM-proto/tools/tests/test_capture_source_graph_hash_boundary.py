from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import capture_multi_segment_evidence_run as capture_module  # noqa: E402


class CaptureSourceGraphHashBoundaryTest(unittest.TestCase):
    def test_normal_source_graph_digest_is_plain_sha256(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            source = Path(raw_dir) / "model_q4.onnx"
            payload = b"stable-source-graph"
            source.write_bytes(payload)

            self.assertEqual(
                capture_module.sha256_file(source),
                hashlib.sha256(payload).hexdigest(),
            )

    def test_same_content_path_replacement_during_hash_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "model_q4.onnx"
            replacement = root / "replacement.onnx"
            payload = b"same-content-source-graph"
            source.write_bytes(payload)
            replacement.write_bytes(payload)
            original_hash = capture_module._descriptor_sha256_file
            replaced = False

            def replace_after_descriptor_hash(
                path: Path,
                *,
                chunk_size: int = 1024 * 1024,
            ) -> str:
                nonlocal replaced
                digest = original_hash(path, chunk_size=chunk_size)
                os.replace(replacement, source)
                replaced = True
                return digest

            with patch.object(
                capture_module,
                "_descriptor_sha256_file",
                side_effect=replace_after_descriptor_hash,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "source model graph path changed while hashing",
                ):
                    capture_module.sha256_file(source)

            self.assertTrue(replaced)
            self.assertEqual(source.read_bytes(), payload)


if __name__ == "__main__":
    unittest.main()
