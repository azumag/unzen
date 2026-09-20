#!/usr/bin/env python3
"""Dependency-neutral capability checks for read-only anchored path traversal."""

from __future__ import annotations

import os


def component_walk_supported() -> bool:
    """Return whether read-only no-follow component traversal is available."""

    open_fn = getattr(os, "open", None)
    stat_fn = getattr(os, "stat", None)
    if not callable(open_fn) or not callable(stat_fn):
        return False

    supports_dir_fd = getattr(os, "supports_dir_fd", set())
    supports_follow_symlinks = getattr(os, "supports_follow_symlinks", set())
    return (
        hasattr(os, "O_DIRECTORY")
        and hasattr(os, "O_NOFOLLOW")
        and open_fn in supports_dir_fd
        and stat_fn in supports_dir_fd
        and stat_fn in supports_follow_symlinks
    )
