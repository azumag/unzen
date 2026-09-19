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

from verify_multi_segment_artifacts import _measure_file, sha256_file  # noqa: E402


class VerifyMultiSegmentArtifactDescriptorPinningTest(unittest.TestCase):
    def test_rejects_invalid_chunk_sizes_before_filesystem_open(self) -> None:
        malformed = (
            0,
            -1,
            True,
            False,
            1.0,
            float("nan"),
            float("inf"),
            float("-inf"),
            "4",
            None,
        )

        for chunk_size in malformed:
            for api in ("measure", "sha256"):
                with self.subTest(chunk_size=chunk_size, api=api):
                    with patch("verify_multi_segment_artifacts.os.open") as open_file:
                        with self.assertRaisesRegex(
                            ValueError, "chunk_size must be a positive integer"
                        ):
                            if api == "measure":
                                _measure_file(
                                    Path("never-opened"), chunk_size=chunk_size  # type: ignore[arg-type]
                                )
                            else:
                                sha256_file(
                                    Path("never-opened"), chunk_size=chunk_size  # type: ignore[arg-type]
                                )
                        open_file.assert_not_called()

    def test_small_positive_chunk_sizes_hash_complete_raw_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "segment.onnx"
            payload = b"line-one\r\nline-two\x1a\x00artifact-hash-contract"
            target.write_bytes(payload)
            expected_sha = hashlib.sha256(payload).hexdigest()

            for chunk_size in (1, 2, 7, len(payload), len(payload) + 3):
                with self.subTest(chunk_size=chunk_size):
                    measured_bytes, measured_sha = _measure_file(target, chunk_size=chunk_size)
                    self.assertEqual(measured_bytes, len(payload))
                    self.assertEqual(measured_sha, expected_sha)
                    self.assertEqual(sha256_file(target, chunk_size=chunk_size), expected_sha)

    def test_path_replacement_after_open_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "segment.onnx"
            replacement = root / "replacement.onnx"
            original_payload = b"original-artifact"
            replacement_payload = b"replacement-artifact-is-longer"
            target.write_bytes(original_payload)
            replacement.write_bytes(replacement_payload)

            original_os_open = os.open
            replaced = False

            def replace_after_open(path, flags, *args, **kwargs):
                nonlocal replaced
                fd = original_os_open(path, flags, *args, **kwargs)
                if Path(path) == target and not replaced:
                    os.replace(replacement, target)
                    replaced = True
                return fd

            with patch("verify_multi_segment_artifacts.os.open", replace_after_open):
                with self.assertRaisesRegex(RuntimeError, "artifact changed while being measured"):
                    _measure_file(target, chunk_size=4)

            self.assertTrue(replaced)
            self.assertEqual(target.read_bytes(), replacement_payload)

    def test_in_place_mutation_while_hashing_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "segment.onnx_data"
            target.write_bytes(b"abcdefgh")
            original_fdopen = os.fdopen

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
                        with target.open("ab") as writer:
                            writer.write(b"!")
                        self.mutated = True
                    return payload

            def mutating_fdopen(fd: int, *args: object, **kwargs: object):
                return MutatingReader(original_fdopen(fd, *args, **kwargs))

            with patch("verify_multi_segment_artifacts.os.fdopen", mutating_fdopen):
                with self.assertRaisesRegex(RuntimeError, "changed while being measured"):
                    _measure_file(target, chunk_size=4)


if __name__ == "__main__":
    unittest.main()
