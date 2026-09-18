from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import source_file_snapshot as target


class SourceFileSnapshotTests(unittest.TestCase):
    def test_graph_snapshot_returns_same_bytes_and_digest(self) -> None:
        payload = b"stable-legacy-source-graph\x00bytes"
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "model.onnx"
            path.write_bytes(payload)

            raw, digest = target.read_regular_file_snapshot(
                path,
                max_bytes=1024,
                label="source model",
            )

        self.assertEqual(raw, payload)
        self.assertEqual(digest, hashlib.sha256(payload).hexdigest())

    def test_external_measurement_binds_size_and_digest(self) -> None:
        payload = b"stable-external-data"
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "weights.bin"
            path.write_bytes(payload)

            size, digest = target.measure_regular_file(
                path,
                hash_file=True,
                label="external data",
            )

        self.assertEqual(size, len(payload))
        self.assertEqual(digest, hashlib.sha256(payload).hexdigest())

    def test_invalid_hash_controls_fail_before_filesystem_access(self) -> None:
        invalid_controls: tuple[object, ...] = (
            None,
            0,
            1,
            "",
            "sha256",
            (),
            [],
            object(),
        )
        with patch.object(
            target,
            "_pin_regular_file",
            side_effect=AssertionError("invalid hash controls must fail before filesystem access"),
        ):
            for value in invalid_controls:
                with self.subTest(hash_file=value):
                    with self.assertRaisesRegex(ValueError, "must be a boolean"):
                        target.measure_regular_file(
                            Path("unused.bin"),
                            hash_file=value,  # type: ignore[arg-type]
                            label="external data",
                        )

    def test_no_hash_mode_does_not_read_payload(self) -> None:
        payload = b"size-only-external-data"
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "weights.bin"
            path.write_bytes(payload)

            with patch.object(
                target.os,
                "read",
                side_effect=AssertionError("size-only mode must not read payload"),
            ):
                size, digest = target.measure_regular_file(
                    path,
                    hash_file=False,
                    label="external data",
                )

        self.assertEqual(size, len(payload))
        self.assertIsNone(digest)

    def test_stable_symlink_is_supported(self) -> None:
        if not hasattr(os, "symlink"):
            self.skipTest("symlink is unavailable")
        payload = b"symlinked-source"
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            real = root / "real.bin"
            requested = root / "requested.bin"
            real.write_bytes(payload)
            try:
                requested.symlink_to(real.name)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error}")

            size, digest = target.measure_regular_file(
                requested,
                hash_file=True,
                label="external data",
            )

        self.assertEqual(size, len(payload))
        self.assertEqual(digest, hashlib.sha256(payload).hexdigest())

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO requires POSIX mkfifo")
    def test_fifo_is_rejected_before_blocking_open(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "weights.bin"
            os.mkfifo(path)

            with self.assertRaisesRegex(RuntimeError, "regular file"):
                target.measure_regular_file(
                    path,
                    hash_file=True,
                    label="external data",
                )

    def test_path_replacement_between_check_and_open_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            path = root / "weights.bin"
            replacement = root / "replacement.bin"
            path.write_bytes(b"original")
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
                    os.replace(replacement, path)
                return real_open(name, flags, *args)

            with patch.object(target.os, "open", side_effect=replace_then_open):
                with self.assertRaisesRegex(RuntimeError, "between path check and open"):
                    target.measure_regular_file(
                        path,
                        hash_file=True,
                        label="external data",
                    )

    def test_hash_time_growth_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "weights.bin"
            path.write_bytes(b"a" * 4096)
            real_read = os.read
            mutated = False

            def mutate_after_read(fd: int, size: int) -> bytes:
                nonlocal mutated
                block = real_read(fd, size)
                if block and not mutated:
                    mutated = True
                    with path.open("ab") as stream:
                        stream.write(b"growth")
                return block

            with patch.object(target.os, "read", side_effect=mutate_after_read):
                with self.assertRaisesRegex(RuntimeError, "changed while being hashed"):
                    target.measure_regular_file(
                        path,
                        hash_file=True,
                        label="external data",
                    )

    def test_invalid_graph_limits_fail_before_filesystem_access(self) -> None:
        invalid_limits: tuple[object, ...] = (
            True,
            False,
            1.0,
            1.5,
            float("nan"),
            float("inf"),
            float("-inf"),
            0,
            -1,
        )
        with patch.object(
            target,
            "_pin_regular_file",
            side_effect=AssertionError("invalid byte limits must fail before filesystem access"),
        ):
            for value in invalid_limits:
                with self.subTest(max_bytes=value):
                    with self.assertRaisesRegex(ValueError, "positive integer"):
                        target.read_regular_file_snapshot(
                            Path("unused.onnx"),
                            max_bytes=value,  # type: ignore[arg-type]
                            label="source model",
                        )

    def test_graph_limit_accepts_exact_positive_integer_boundary(self) -> None:
        payload = b"12345"
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "model.onnx"
            path.write_bytes(payload)

            raw, digest = target.read_regular_file_snapshot(
                path,
                max_bytes=len(payload),
                label="source model",
            )

        self.assertEqual(raw, payload)
        self.assertEqual(digest, hashlib.sha256(payload).hexdigest())

    def test_graph_limit_is_fail_close(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "model.onnx"
            path.write_bytes(b"12345")

            with self.assertRaisesRegex(RuntimeError, "exceeds 4 bytes"):
                target.read_regular_file_snapshot(
                    path,
                    max_bytes=4,
                    label="source model",
                )


if __name__ == "__main__":
    unittest.main()
