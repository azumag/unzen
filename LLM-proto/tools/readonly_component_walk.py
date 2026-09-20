#!/usr/bin/env python3
"""Dependency-neutral capability checks for read-only anchored path traversal."""

from __future__ import annotations

import os


def component_walk_supported() -> bool:
    """Return whether read-only no-follow component traversal is available."""

    supports_dir_fd = getattr(os, "supports_dir_fd", set())
    supports_follow_symlinks = getattr(os, "supports_follow_symlinks", set())
    return (
        hasattr(os, "O_DIRECTORY")
        and hasattr(os, "O_NOFOLLOW")
        and os.open in supports_dir_fd
        and os.stat in supports_dir_fd
        and os.stat in supports_follow_symlinks
    )
