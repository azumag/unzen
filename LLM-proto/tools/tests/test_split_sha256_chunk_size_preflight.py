from __future__ import annotations

import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import split_llama_1b_onnx as splitter  # noqa: E402


INVALID_CHUNK_SIZES = (
    True,
    False,
    0,
    -1,
    1.0,
    1.5,
    float("nan"),
    float("inf"),
    float("-inf"),
    "1",
    None,
    [],
    (),
)


class SplitSha256ChunkSizePreflightTest(unittest.TestCase):
    def test_invalid_chunk_sizes_fail_before_open(self) -> None:
        for value in INVALID_CHUNK_SIZES:
            with self.subTest(value=value), mock.patch.object(
                Path,
                "open",
                side_effect=AssertionError("path open must not run"),
            ) as open_mock:
                with self.assertRaisesRegex(ValueError, "chunk_size must be a positive integer"):
                    splitter.sha256_file(Path("unused.bin"), value)  # type: ignore[arg-type]
                open_mock.assert_not_called()

    def test_default_and_small_positive_chunks_hash_the_complete_file(self) -> None:
        payload = b"unzen split sha256 chunk contract\x00\x01\xff" * 3
        expected = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "payload.bin"
            path.write_bytes(payload)

            self.assertEqual(splitter.sha256_file(path), expected)
            for chunk_size in (1, 2, 7, len(payload), len(payload) + 1):
                with self.subTest(chunk_size=chunk_size):
                    self.assertEqual(
                        splitter.sha256_file(path, chunk_size=chunk_size),
                        expected,
                    )


if __name__ == "__main__":
    unittest.main()
