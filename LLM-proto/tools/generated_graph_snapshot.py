from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import tempfile

import onnx


def _identity(snapshot: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        snapshot.st_dev,
        snapshot.st_ino,
        snapshot.st_size,
        snapshot.st_mtime_ns,
        snapshot.st_ctime_ns,
    )


def validate_and_measure_generated_graph(path: Path) -> tuple[int, str]:
    """Validate and hash one generated ONNX graph from a single accepted snapshot.

    The public graph pathname is opened only after a non-symlink regular-file
    preflight, using nonblocking/no-follow/binary-safe flags where the platform
    provides them. The exact bytes read from that pinned descriptor are copied
    to an exclusive checker file in the same directory so ONNX external-data
    locations keep their existing relative resolution. The checker therefore
    validates the same serialized graph bytes used for the returned size and
    SHA-256, without reopening the public graph pathname.
    """

    requested = path.expanduser().absolute()
    try:
        before = os.lstat(requested)
    except OSError as error:
        raise RuntimeError(f"generated graph is not readable: {requested}: {error}") from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise RuntimeError(f"generated graph must be a regular non-symlink file: {requested}")

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        source_fd = os.open(requested, flags)
    except OSError as error:
        raise RuntimeError(f"generated graph could not be opened safely: {requested}: {error}") from error

    checker_path: Path | None = None
    checker_fd = -1
    digest = hashlib.sha256()
    observed = 0
    opened: os.stat_result | None = None
    try:
        opened = os.fstat(source_fd)
        if not stat.S_ISREG(opened.st_mode):
            raise RuntimeError(f"generated graph must remain a regular file: {requested}")
        if _identity(opened) != _identity(before):
            raise RuntimeError(f"generated graph changed between path check and open: {requested}")

        checker_fd, checker_name = tempfile.mkstemp(
            prefix=f".{requested.name}.checker-",
            suffix=".onnx",
            dir=requested.parent,
        )
        checker_path = Path(checker_name)
        with os.fdopen(checker_fd, "wb", closefd=False) as checker_stream:
            while True:
                block = os.read(source_fd, 1024 * 1024)
                if not block:
                    break
                written = checker_stream.write(block)
                if written != len(block):
                    raise RuntimeError(f"short write while staging generated graph checker snapshot: {requested}")
                digest.update(block)
                observed += len(block)
            checker_stream.flush()
            os.fsync(checker_fd)

        after_fd = os.fstat(source_fd)
        if _identity(after_fd) != _identity(opened) or observed != after_fd.st_size:
            raise RuntimeError(f"generated graph changed while being snapshotted: {requested}")

        try:
            after_path = os.lstat(requested)
        except OSError as error:
            raise RuntimeError(f"generated graph path disappeared after snapshot: {requested}") from error
        if stat.S_ISLNK(after_path.st_mode) or _identity(after_path) != _identity(opened):
            raise RuntimeError(f"generated graph path changed while being snapshotted: {requested}")

        checker_before = os.fstat(checker_fd)
        if not stat.S_ISREG(checker_before.st_mode) or checker_before.st_size != observed:
            raise RuntimeError(f"generated graph checker snapshot is not stable: {requested}")
        checker_path_before = os.lstat(checker_path)
        if stat.S_ISLNK(checker_path_before.st_mode) or _identity(checker_path_before) != _identity(checker_before):
            raise RuntimeError(f"generated graph checker snapshot path changed before validation: {requested}")

        onnx.checker.check_model(str(checker_path), full_check=True)

        checker_after = os.fstat(checker_fd)
        try:
            checker_path_after = os.lstat(checker_path)
        except OSError as error:
            raise RuntimeError(f"generated graph checker snapshot disappeared during validation: {requested}") from error
        if (
            _identity(checker_after) != _identity(checker_before)
            or stat.S_ISLNK(checker_path_after.st_mode)
            or _identity(checker_path_after) != _identity(checker_before)
        ):
            raise RuntimeError(f"generated graph checker snapshot changed during validation: {requested}")

        try:
            final_path = os.lstat(requested)
        except OSError as error:
            raise RuntimeError(f"generated graph path disappeared during validation: {requested}") from error
        if stat.S_ISLNK(final_path.st_mode) or _identity(final_path) != _identity(opened):
            raise RuntimeError(f"generated graph path changed during validation: {requested}")

        return observed, digest.hexdigest()
    finally:
        os.close(source_fd)
        if checker_fd >= 0:
            os.close(checker_fd)
        if checker_path is not None:
            try:
                checker_path.unlink(missing_ok=True)
            except OSError:
                pass
