#!/usr/bin/env python3
"""Fail-fast regular-file snapshot opens for host-side diagnostic source readers."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import BinaryIO


StatSignature = tuple[int, int, int, int, int]


def stat_signature(stat_result: os.stat_result) -> StatSignature:
    return (
        stat_result.st_dev,
        stat_result.st_ino,
        stat_result.st_size,
        stat_result.st_mtime_ns,
        stat_result.st_ctime_ns,
    )


def open_stable_regular_file(path: Path, *, context: str) -> BinaryIO:
    """Open one requested regular-file identity without a blocking special-file race.

    The requested path may contain symlinks.  We first capture the identity reached by
    that path, resolve it, then open the resolved final component with no-follow and
    non-blocking flags where the host provides them.  The descriptor and the requested
    path are both rechecked against the pre-open identity before a stream is returned.
    """

    requested_path = path.expanduser().absolute()
    try:
        before = requested_path.stat()
    except OSError as error:
        raise RuntimeError(f"{context} is not readable: {requested_path}: {error}") from error
    if not stat.S_ISREG(before.st_mode):
        raise RuntimeError(f"{context} must be a regular file: {requested_path}")
    expected_signature = stat_signature(before)

    try:
        resolved_path = requested_path.resolve(strict=True)
    except OSError as error:
        raise RuntimeError(
            f"{context} could not be resolved safely: {requested_path}: {error}"
        ) from error

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = -1
    try:
        fd = os.open(resolved_path, flags)
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise RuntimeError(f"{context} must remain a regular file: {requested_path}")
        if stat_signature(opened) != expected_signature:
            raise RuntimeError(f"{context} changed between path check and open: {requested_path}")
        try:
            requested_after_open = requested_path.stat()
        except OSError as error:
            raise RuntimeError(
                f"{context} requested path changed during open: {requested_path}: {error}"
            ) from error
        if stat_signature(requested_after_open) != expected_signature:
            raise RuntimeError(f"{context} requested path changed during open: {requested_path}")

        stream = os.fdopen(fd, "rb", closefd=True)
        fd = -1
        return stream
    finally:
        if fd >= 0:
            os.close(fd)
