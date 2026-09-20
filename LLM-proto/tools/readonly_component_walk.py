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


def _capability_contains(name: str, function: object) -> bool:
    capabilities = getattr(os, name, ())
    try:
        return function in capabilities
    except TypeError:
        return False


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

    return (
        _capability_contains("supports_dir_fd", open_fn)
        and _capability_contains("supports_dir_fd", stat_fn)
        and _capability_contains("supports_follow_symlinks", stat_fn)
    )
