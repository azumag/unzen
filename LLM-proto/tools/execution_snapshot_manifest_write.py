#!/usr/bin/env python3
"""Dependency-neutral capability checks for generated snapshot manifest writes."""

from __future__ import annotations

import os


_REQUIRED_CALLABLES = ("open", "write", "close")
_REQUIRED_FLAGS = ("O_WRONLY", "O_CREAT", "O_EXCL")
_OPTIONAL_FLAGS = ("O_NOFOLLOW", "O_CLOEXEC")
_MISSING = object()


def _integer_flag(name: str, *, required: bool) -> bool:
    raw = getattr(os, name, _MISSING)
    if raw is _MISSING:
        return not required
    return type(raw) is int


def manifest_write_supported() -> bool:
    """Return whether generated snapshots can create and write a pinned manifest."""

    if not all(callable(getattr(os, name, None)) for name in _REQUIRED_CALLABLES):
        return False

    open_fn = getattr(os, "open", None)
    supports_dir_fd = getattr(os, "supports_dir_fd", ())
    try:
        if open_fn not in supports_dir_fd:
            return False
    except TypeError:
        return False

    if not all(_integer_flag(name, required=True) for name in _REQUIRED_FLAGS):
        return False
    return all(_integer_flag(name, required=False) for name in _OPTIONAL_FLAGS)


def assert_manifest_write_supported(*, label: str) -> None:
    """Fail closed before generated artifact verification on unsupported hosts."""

    if manifest_write_supported():
        return
    raise RuntimeError(
        f"{label} requires descriptor-relative os.open/os.write/os.close plus "
        "integer O_WRONLY/O_CREAT/O_EXCL and well-formed optional "
        "O_NOFOLLOW/O_CLOEXEC flags to write the pinned split manifest"
    )
