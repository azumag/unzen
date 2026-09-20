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

import prepare_browser_p0 as p0_module  # noqa: E402
import source_file_snapshot as snapshot_module  # noqa: E402


class BrowserP0SourceSnapshotTest(unittest.TestCase):
    def test_delegates_hashing_to_shared_snapshot_boundary(self) -> None:
        source = Path("model.onnx")
        digest = "a" * 64

        with mock.patch.object(
            p0_module,
            "measure_regular_file",
            return_value=(123, digest),
        ) as measure:
            self.assertEqual(p0_module.sha256_file(source), digest)

        measure.assert_called_once_with(
            source,
            hash_file=True,
            label="P0 source graph",
        )

    def test_hashes_stable_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "model.onnx"
            payload = b"stable-source-graph" * 1024
            source.write_bytes(payload)

            self.assertEqual(
                p0_module.sha256_file(source),
                hashlib.sha256(payload).hexdigest(),
            )

    def test_requests_binary_mode_when_available(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "model.onnx"
            payload = b"line1\r\nline2\x1a\n"
            source.write_bytes(payload)
            resolved = source.resolve()
            fake_binary_flag = 1 << 29
            real_open = os.open
            observed: dict[str, object] = {}

            def capturing_open(path: object, flags: int, *args: object, **kwargs: object) -> int:
                observed["path"] = Path(os.fspath(path))
                observed["flags"] = flags
                return real_open(path, flags & ~fake_binary_flag, *args, **kwargs)

            with (
                mock.patch.object(snapshot_module.os, "O_BINARY", fake_binary_flag, create=True),
                mock.patch.object(snapshot_module.os, "open", side_effect=capturing_open),
            ):
                digest = p0_module.sha256_file(source)

            self.assertEqual(digest, hashlib.sha256(payload).hexdigest())
            self.assertEqual(observed["path"], resolved)
            self.assertTrue(int(observed["flags"]) & fake_binary_flag)

    def test_accepts_stable_symlink_to_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "model-real.onnx"
            link = root / "model.onnx"
            payload = b"symlink-source-graph"
            target.write_bytes(payload)
            try:
                link.symlink_to(target.name)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks are unavailable")

            self.assertEqual(
                p0_module.sha256_file(link),
                hashlib.sha256(payload).hexdigest(),
            )

    def test_rejects_path_replacement_between_check_and_open(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            replacement = root / "replacement.onnx"
            source.write_bytes(b"original")
            replacement.write_bytes(b"replacement")
            resolved = source.resolve()
            real_open = snapshot_module.os.open
            swapped = False

            def swap_then_open(path: object, flags: int, *args: object, **kwargs: object) -> int:
                nonlocal swapped
                candidate = Path(os.fspath(path))
                if not swapped and candidate == resolved:
                    source.unlink()
                    replacement.replace(source)
                    swapped = True
                return real_open(path, flags, *args, **kwargs)

            with mock.patch.object(snapshot_module.os, "open", side_effect=swap_then_open):
                with self.assertRaisesRegex(RuntimeError, "changed between path check and open"):
                    p0_module.sha256_file(source)
            self.assertTrue(swapped)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO support is unavailable")
    def test_rejects_fifo_without_opening_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fifo = Path(tmp) / "model.onnx"
            os.mkfifo(fifo)

            with self.assertRaisesRegex(RuntimeError, "must resolve to a regular file"):
                p0_module.sha256_file(fifo)

    def test_rejects_in_place_mutation_while_hashing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "model.onnx"
            source.write_bytes(b"a" * (2 * 1024 * 1024))
            real_read = snapshot_module.os.read
            mutated = False

            def read_then_mutate(fd: int, count: int) -> bytes:
                nonlocal mutated
                block = real_read(fd, count)
                if block and not mutated:
                    with source.open("r+b") as stream:
                        stream.seek(0)
                        stream.write(b"z")
                        stream.flush()
                        os.fsync(stream.fileno())
                    mutated = True
                return block

            with mock.patch.object(snapshot_module.os, "read", side_effect=read_then_mutate):
                with self.assertRaisesRegex(RuntimeError, "changed while being hashed"):
                    p0_module.sha256_file(source)
            self.assertTrue(mutated)


if __name__ == "__main__":
    unittest.main()
