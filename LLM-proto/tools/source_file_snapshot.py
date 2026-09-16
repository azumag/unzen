from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path


def _stat_signature(snapshot: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        snapshot.st_dev,
        snapshot.st_ino,
        snapshot.st_size,
        snapshot.st_mtime_ns,
        snapshot.st_ctime_ns,
    )


def _pin_regular_file(path: Path, *, label: str) -> tuple[Path, Path, os.stat_result, int]:
    requested = path.expanduser().absolute()
    try:
        resolved = requested.resolve(strict=True)
    except (FileNotFoundError, OSError) as error:
        raise FileNotFoundError(f"{label} not found: {requested}") from error

    try:
        before = os.lstat(resolved)
    except OSError as error:
        raise FileNotFoundError(f"{label} not found: {requested}") from error
    if not stat.S_ISREG(before.st_mode):
        raise RuntimeError(f"{label} must resolve to a regular file: {requested}")

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(resolved, flags)
    except OSError as error:
        raise RuntimeError(f"{label} could not be opened safely: {requested}: {error}") from error

    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise RuntimeError(f"{label} must remain a regular file: {requested}")
        if _stat_signature(opened) != _stat_signature(before):
            raise RuntimeError(f"{label} changed between path check and open: {requested}")
    except Exception:
        os.close(fd)
        raise

    return requested, resolved, opened, fd


def _verify_path_identity(
    requested: Path,
    resolved: Path,
    opened: os.stat_result,
    *,
    label: str,
) -> None:
    try:
        after_path = os.lstat(resolved)
    except OSError as error:
        raise RuntimeError(f"{label} path disappeared after measurement: {requested}") from error
    if stat.S_ISLNK(after_path.st_mode) or _stat_signature(after_path) != _stat_signature(opened):
        raise RuntimeError(f"{label} path changed while being measured: {requested}")

    try:
        requested_after = requested.resolve(strict=True)
    except (FileNotFoundError, OSError) as error:
        raise RuntimeError(f"{label} requested path changed while being measured: {requested}") from error
    if requested_after != resolved:
        raise RuntimeError(f"{label} requested path changed while being measured: {requested}")


def read_regular_file_snapshot(
    path: Path,
    *,
    max_bytes: int,
    label: str,
) -> tuple[bytes, str]:
    """Read one bounded regular-file descriptor snapshot and return bytes + SHA-256."""

    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    requested, resolved, opened, fd = _pin_regular_file(path, label=label)
    if opened.st_size > max_bytes:
        os.close(fd)
        raise RuntimeError(f"{label} exceeds {max_bytes} bytes: {requested}")

    chunks: list[bytes] = []
    observed = 0
    try:
        while True:
            remaining = max_bytes + 1 - observed
            block = os.read(fd, min(1024 * 1024, remaining))
            if not block:
                break
            chunks.append(block)
            observed += len(block)
            if observed > max_bytes:
                raise RuntimeError(f"{label} grew beyond the input limit: {requested}")

        after_fd = os.fstat(fd)
        if _stat_signature(after_fd) != _stat_signature(opened) or observed != after_fd.st_size:
            raise RuntimeError(f"{label} changed while being read: {requested}")
    finally:
        os.close(fd)

    _verify_path_identity(requested, resolved, opened, label=label)
    raw = b"".join(chunks)
    return raw, hashlib.sha256(raw).hexdigest()


def measure_regular_file(
    path: Path,
    *,
    hash_file: bool,
    label: str,
) -> tuple[int, str | None]:
    """Measure size and optional SHA-256 from one regular-file descriptor identity."""

    requested, resolved, opened, fd = _pin_regular_file(path, label=label)
    digest = hashlib.sha256() if hash_file else None
    observed = 0
    try:
        if digest is not None:
            while True:
                block = os.read(fd, 4 * 1024 * 1024)
                if not block:
                    break
                digest.update(block)
                observed += len(block)

        after_fd = os.fstat(fd)
        if _stat_signature(after_fd) != _stat_signature(opened):
            action = "hashed" if hash_file else "measured"
            raise RuntimeError(f"{label} changed while being {action}: {requested}")
        if hash_file and observed != after_fd.st_size:
            raise RuntimeError(f"{label} changed while being hashed: {requested}")
    finally:
        os.close(fd)

    _verify_path_identity(requested, resolved, opened, label=label)
    return opened.st_size, None if digest is None else digest.hexdigest()
