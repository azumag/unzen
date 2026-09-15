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

import prepare_real_split as repack_module  # noqa: E402


class RepackOutputSnapshotTest(unittest.TestCase):
    def test_stable_regular_file_returns_size_and_digest_from_same_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "segment0.onnx_data"
            payload = b"stable-repacked-payload"
            path.write_bytes(payload)
            expected_snapshot = repack_module._file_snapshot(path.lstat())

            measured_bytes, measured_sha256 = repack_module._measure_repacked_output(
                path,
                expected_snapshot=expected_snapshot,
            )

            self.assertEqual(measured_bytes, len(payload))
            self.assertEqual(measured_sha256, hashlib.sha256(payload).hexdigest())

    def test_rejects_path_replacement_after_repack_even_with_same_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "segment0.onnx_data"
            payload = b"same-content-replacement"
            path.write_bytes(payload)
            expected_snapshot = repack_module._file_snapshot(path.lstat())

            path.unlink()
            path.write_bytes(payload)

            with self.assertRaisesRegex(
                RuntimeError,
                "repacked external-data pathname changed after repack",
            ):
                repack_module._measure_repacked_output(
                    path,
                    expected_snapshot=expected_snapshot,
                )

    def test_rejects_non_regular_replacement_before_open(self) -> None:
        if not hasattr(os, "mkfifo"):
            self.skipTest("FIFO creation is unavailable on this platform")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "segment0.onnx_data"
            os.mkfifo(path)
            expected_snapshot = repack_module._file_snapshot(path.lstat())

            with self.assertRaisesRegex(ValueError, "must remain a regular file"):
                repack_module._measure_repacked_output(
                    path,
                    expected_snapshot=expected_snapshot,
                )

    def test_rejects_in_place_mutation_during_measurement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "segment0.onnx_data"
            path.write_bytes(b"a" * 32)
            expected_snapshot = repack_module._file_snapshot(path.lstat())
            real_read = os.read
            mutated = False

            def mutating_read(descriptor: int, size: int) -> bytes:
                nonlocal mutated
                chunk = real_read(descriptor, size)
                if chunk and not mutated:
                    with path.open("ab") as stream:
                        stream.write(b"mutation")
                    mutated = True
                return chunk

            with patch.object(repack_module.os, "read", side_effect=mutating_read):
                with self.assertRaisesRegex(RuntimeError, "changed while measuring"):
                    repack_module._measure_repacked_output(
                        path,
                        expected_snapshot=expected_snapshot,
                    )


if __name__ == "__main__":
    unittest.main()
