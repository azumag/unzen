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
import multi_segment_onnx as split_module  # noqa: E402


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
            self.assertEqual(
                capture_module.sha256_file(source, 4),
                hashlib.sha256(payload).hexdigest(),
            )

    def test_source_graph_at_shared_policy_limit_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            source = Path(raw_dir) / "model_q4.onnx"
            payload = b"12345678"
            source.write_bytes(payload)

            with patch.object(
                capture_module,
                "DEFAULT_SOURCE_GRAPH_MAX_BYTES",
                len(payload),
            ):
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
            original_read = split_module.os.read
            replaced = False

            def replace_after_first_read(fd: int, size: int) -> bytes:
                nonlocal replaced
                block = original_read(fd, size)
                if block and not replaced:
                    os.replace(replacement, source)
                    replaced = True
                return block

            with patch.object(
                split_module.os,
                "read",
                side_effect=replace_after_first_read,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "source model path changed while being read",
                ):
                    capture_module.sha256_file(source)

            self.assertTrue(replaced)
            self.assertEqual(source.read_bytes(), payload)

    def test_oversized_source_graph_fails_before_staging_or_generation(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "model_q4.onnx"
            destination = root / "capture"
            source.write_bytes(b"123456789")

            with (
                patch.object(capture_module, "DEFAULT_SOURCE_GRAPH_MAX_BYTES", 8),
                patch.object(capture_module, "ensure_provider_available") as provider,
                patch.object(capture_module, "_make_staging_dir") as staging,
                patch.object(capture_module, "prepare_budgeted_multi_split") as prepare,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "source model graph exceeds 8 bytes",
                ):
                    capture_module.capture_run(source, destination, [11])

            provider.assert_called_once_with("CPUExecutionProvider")
            staging.assert_not_called()
            prepare.assert_not_called()
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
