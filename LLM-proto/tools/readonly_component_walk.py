#!/usr/bin/env python3
"""Dependency-neutral capability checks for read-only anchored path traversal."""

from __future__ import annotations

import os


_REQUIRED_OPEN_FLAGS = ("O_RDONLY", "O_DIRECTORY", "O_NOFOLLOW")
_OPTIONAL_OPEN_FLAGS = ("O_CLOEXEC", "O_NONBLOCK")
_MISSING = object()


def _integer_flag(name: str, *, required: bool) -> bool:
    raw = getattr(os, name, _MISSING)
    if raw is _MISSING:
        return not required
    return type(raw) is int


def component_walk_supported() -> bool:
    """Return whether read-only no-follow component traversal is available."""

    open_fn = getattr(os, "open", None)
    stat_fn = getattr(os, "stat", None)
    if not callable(open_fn) or not callable(stat_fn):
        return False
    if not all(_integer_flag(name, required=True) for name in _REQUIRED_OPEN_FLAGS):
        return False
    if not all(_integer_flag(name, required=False) for name in _OPTIONAL_OPEN_FLAGS):
        return False

    supports_dir_fd = getattr(os, "supports_dir_fd", set())
    supports_follow_symlinks = getattr(os, "supports_follow_symlinks", set())
    return (
        open_fn in supports_dir_fd
        and stat_fn in supports_dir_fd
        and stat_fn in supports_follow_symlinks
    )
