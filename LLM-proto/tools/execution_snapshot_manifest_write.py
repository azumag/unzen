#!/usr/bin/env python3
"""Dependency-neutral capability checks for generated snapshot manifest writes."""

from __future__ import annotations

import os


_REQUIRED_CALLABLES = ("open", "write", "close")
_REQUIRED_FLAGS = ("O_WRONLY", "O_CREAT", "O_EXCL")


def manifest_write_supported() -> bool:
    """Return whether generated snapshots can create and write a pinned manifest."""

    if not all(callable(getattr(os, name, None)) for name in _REQUIRED_CALLABLES):
        return False
    return all(isinstance(getattr(os, name, None), int) for name in _REQUIRED_FLAGS)


def assert_manifest_write_supported(*, label: str) -> None:
    """Fail closed before generated artifact verification on unsupported hosts."""

    if manifest_write_supported():
        return
    raise RuntimeError(
        f"{label} requires os.open/os.write/os.close plus "
        "O_WRONLY/O_CREAT/O_EXCL to write the pinned split manifest"
    )
