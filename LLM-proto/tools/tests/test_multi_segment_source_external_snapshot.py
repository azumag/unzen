from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import multi_segment_onnx as target


def _external_model(
    location: str = "weights.bin",
    *,
    offset: int = 0,
    length: int = 1,
) -> object:
    initializer = SimpleNamespace(
        name="weight",
        data_location=target.TensorProto.EXTERNAL,
        external_data=[
            SimpleNamespace(key="location", value=location),
            SimpleNamespace(key="offset", value=str(offset)),
            SimpleNamespace(key="length", value=str(length)),
        ],
    )
    return SimpleNamespace(graph=SimpleNamespace(initializer=[initializer]))


class SourceExternalSnapshotTests(unittest.TestCase):
    def test_manifest_binds_size_and_digest_to_same_file(self) -> None:
        payload = b"stable-external-data\x00bytes"
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            external = root / "weights.bin"
            external.write_bytes(payload)

            manifest = target._source_external_manifest(
                _external_model(length=len(payload)),
                root / "model.onnx",
                hash_files=True,
            )

        self.assertEqual(
            manifest,
            [
                {
                    "location": "weights.bin",
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            ],
        )

    def test_hash_mode_requests_binary_descriptor_when_available(self) -> None:
        payload = b"line1\r\nline2\x1a\n"
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            external = root / "weights.bin"
            external.write_bytes(payload)
            fake_binary_flag = 1 << 29
            real_open = os.open
            observed: dict[str, object] = {}

            def capturing_open(
                name: os.PathLike[str] | str,
                flags: int,
                *args: object,
            ) -> int:
                observed["path"] = Path(name)
                observed["flags"] = flags
                return real_open(name, flags & ~fake_binary_flag, *args)

            with (
                patch.object(target.os, "O_BINARY", fake_binary_flag, create=True),
                patch.object(target.os, "open", side_effect=capturing_open),
            ):
                size, digest = target._measure_source_external_file(
                    external,
                    hash_file=True,
                )

        self.assertEqual(size, len(payload))
        self.assertEqual(digest, hashlib.sha256(payload).hexdigest())
        self.assertEqual(observed["path"], external.resolve())
        self.assertTrue(int(observed["flags"]) & fake_binary_flag)

    def test_no_hash_mode_does_not_read_payload(self) -> None:
        payload = b"size-only-external-data"
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            external = root / "weights.bin"
            external.write_bytes(payload)

            with patch.object(
                target.os,
                "read",
                side_effect=AssertionError("no-hash mode must not read payload bytes"),
            ):
                manifest = target._source_external_manifest(
                    _external_model(length=len(payload)),
                    root / "model.onnx",
                    hash_files=False,
                )

        self.assertEqual(
            manifest,
            [{"location": "weights.bin", "bytes": len(payload)}],
        )

    def test_stable_symlink_keeps_existing_path_semantics(self) -> None:
        if not hasattr(os, "symlink"):
            self.skipTest("symlink is unavailable")
        payload = b"symlinked-external-data"
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            real = root / "real.bin"
            requested = root / "weights.bin"
            real.write_bytes(payload)
            try:
                requested.symlink_to(real.name)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error}")

            manifest = target._source_external_manifest(
                _external_model(length=len(payload)),
                root / "model.onnx",
                hash_files=True,
            )

        self.assertEqual(manifest[0]["bytes"], len(payload))
        self.assertEqual(manifest[0]["sha256"], hashlib.sha256(payload).hexdigest())

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO requires POSIX mkfifo")
    def test_fifo_is_rejected_before_blocking_open(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            os.mkfifo(root / "weights.bin")

            with self.assertRaisesRegex(RuntimeError, "regular file"):
                target._source_external_manifest(
                    _external_model(),
                    root / "model.onnx",
                    hash_files=True,
                )

    def test_path_replacement_between_check_and_open_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            external = root / "weights.bin"
            replacement = root / "replacement.bin"
            external.write_bytes(b"original")
            replacement.write_bytes(b"replacement")
            real_open = os.open
            replaced = False

            def replace_then_open(
                name: os.PathLike[str] | str,
                flags: int,
                *args: object,
            ) -> int:
                nonlocal replaced
                if not replaced:
                    replaced = True
                    os.replace(replacement, external)
                return real_open(name, flags, *args)

            with patch.object(target.os, "open", side_effect=replace_then_open):
                with self.assertRaisesRegex(RuntimeError, "between path check and open"):
                    target._source_external_manifest(
                        _external_model(length=8),
                        root / "model.onnx",
                        hash_files=True,
                    )

    def test_hash_time_growth_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            external = root / "weights.bin"
            external.write_bytes(b"a" * 4096)
            real_read = os.read
            mutated = False

            def mutate_after_read(fd: int, size: int) -> bytes:
                nonlocal mutated
                block = real_read(fd, size)
                if block and not mutated:
                    mutated = True
                    with external.open("ab") as stream:
                        stream.write(b"growth")
                return block

            with patch.object(target.os, "read", side_effect=mutate_after_read):
                with self.assertRaisesRegex(RuntimeError, "changed while being hashed"):
                    target._source_external_manifest(
                        _external_model(length=4096),
                        root / "model.onnx",
                        hash_files=True,
                    )

    def test_range_validation_uses_measured_snapshot_size(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            external = root / "weights.bin"
            external.write_bytes(b"1234")

            with self.assertRaisesRegex(ValueError, "external-data range exceeds"):
                target._source_external_manifest(
                    _external_model(offset=3, length=2),
                    root / "model.onnx",
                    hash_files=False,
                )


if __name__ == "__main__":
    unittest.main()
