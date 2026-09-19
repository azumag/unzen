from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import source_file_snapshot as snapshots  # noqa: E402
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
    def test_invalid_chunk_sizes_fail_before_snapshot_open(self) -> None:
        for value in INVALID_CHUNK_SIZES:
            with self.subTest(value=value), mock.patch.object(
                splitter,
                "open_regular_file_snapshot",
                side_effect=AssertionError("snapshot open must not run"),
            ) as open_mock:
                with self.assertRaisesRegex(ValueError, "chunk_size must be a positive integer"):
                    splitter.sha256_file(Path("unused.bin"), value)  # type: ignore[arg-type]
                open_mock.assert_not_called()

    def test_default_and_small_positive_chunks_hash_exact_raw_bytes(self) -> None:
        payload = b"unzen split sha256\r\nchunk contract\x00\x1a\xff" * 3
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

    @unittest.skipUnless(
        hasattr(os, "mkfifo") and bool(getattr(os, "O_NONBLOCK", 0)),
        "FIFO replacement regression requires mkfifo and O_NONBLOCK",
    )
    def test_fifo_replacement_fails_before_special_file_read(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "segment.onnx"
            path.write_bytes(b"generated graph")
            opened_target = path.resolve()
            real_open = snapshots.os.open
            replaced = False

            def open_after_fifo_swap(
                name: os.PathLike[str] | str,
                flags: int,
                *args: object,
                **kwargs: object,
            ) -> int:
                nonlocal replaced
                if not replaced and Path(name) == opened_target:
                    path.unlink()
                    os.mkfifo(path)
                    replaced = True
                return real_open(name, flags, *args, **kwargs)

            with mock.patch.object(snapshots.os, "open", side_effect=open_after_fifo_swap):
                with self.assertRaisesRegex(RuntimeError, "must remain a regular file"):
                    splitter.sha256_file(path, chunk_size=2)

            self.assertTrue(replaced)

    def test_same_content_inode_replacement_is_rejected_before_hashing(self) -> None:
        payload = b"same-content graph"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "segment.onnx"
            replacement = root / "replacement.onnx"
            path.write_bytes(payload)
            replacement.write_bytes(payload)
            opened_target = path.resolve()
            real_open = snapshots.os.open
            replaced = False

            def open_then_replace(
                name: os.PathLike[str] | str,
                flags: int,
                *args: object,
                **kwargs: object,
            ) -> int:
                nonlocal replaced
                fd = real_open(name, flags, *args, **kwargs)
                if not replaced and Path(name) == opened_target:
                    os.replace(replacement, path)
                    replaced = True
                return fd

            with mock.patch.object(snapshots.os, "open", side_effect=open_then_replace):
                with self.assertRaisesRegex(RuntimeError, "changed between path check and open"):
                    splitter.sha256_file(path, chunk_size=3)

            self.assertTrue(replaced)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink requires OS support")
    def test_same_content_requested_symlink_retarget_is_rejected(self) -> None:
        payload = b"same-content graph"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.onnx"
            second = root / "second.onnx"
            requested = root / "segment.onnx"
            first.write_bytes(payload)
            second.write_bytes(payload)
            try:
                requested.symlink_to(first.name)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error}")

            opened_target = first.resolve()
            real_open = snapshots.os.open
            retargeted = False

            def open_then_retarget(
                name: os.PathLike[str] | str,
                flags: int,
                *args: object,
                **kwargs: object,
            ) -> int:
                nonlocal retargeted
                fd = real_open(name, flags, *args, **kwargs)
                if not retargeted and Path(name) == opened_target:
                    requested.unlink()
                    requested.symlink_to(second.name)
                    retargeted = True
                return fd

            with mock.patch.object(snapshots.os, "open", side_effect=open_then_retarget):
                with self.assertRaisesRegex(RuntimeError, "requested path changed"):
                    splitter.sha256_file(requested, chunk_size=4)

            self.assertTrue(retargeted)


if __name__ == "__main__":
    unittest.main()
