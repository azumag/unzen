#!/usr/bin/env python3
"""Dependency-neutral helpers for execution-snapshot destination paths.

These helpers keep nested destination parent traversal anchored to directory
handles where the host supports ``dir_fd`` + ``O_NOFOLLOW`` and the
``follow_symlinks=False`` forms used by the anchored operations. Callers retain
file-specific provenance checks; this module owns only workspace/parent path
identity and rollback mechanics.
"""

from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import stat
from typing import Iterator, Sequence


SnapshotWorkspaceIdentity = tuple[int, int]
InternalParentIdentity = tuple[tuple[str, ...], int, int]


def nofollow_hardlink_supported() -> bool:
    """Return whether ``os.link`` supports an explicit no-follow source contract."""

    supports_follow_symlinks = getattr(os, "supports_follow_symlinks", set())
    return os.link in supports_follow_symlinks


def nofollow_stat_supported() -> bool:
    """Return whether ``os.stat`` supports explicit no-follow metadata reads."""

    supports_follow_symlinks = getattr(os, "supports_follow_symlinks", set())
    return os.stat in supports_follow_symlinks


def component_walk_supported() -> bool:
    supports_dir_fd = getattr(os, "supports_dir_fd", set())
    return (
        hasattr(os, "O_DIRECTORY")
        and hasattr(os, "O_NOFOLLOW")
        and os.open in supports_dir_fd
        and os.mkdir in supports_dir_fd
        and os.link in supports_dir_fd
        and os.stat in supports_dir_fd
        and os.unlink in supports_dir_fd
        and nofollow_hardlink_supported()
        and nofollow_stat_supported()
    )


def _open_flags() -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    return flags


def workspace_identity(path: Path, *, label: str) -> SnapshotWorkspaceIdentity:
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise RuntimeError(f"{label} workspace changed: {path}") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(f"{label} workspace changed: {path}")
    return metadata.st_dev, metadata.st_ino


def _record_parent_identity(
    parts: tuple[str, ...],
    metadata: os.stat_result,
    *,
    label: str,
) -> InternalParentIdentity:
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(f"{label} internal parent is not a directory: {'/'.join(parts)}")
    return parts, metadata.st_dev, metadata.st_ino


def _assert_root_identity(
    snapshot_root: Path,
    expected_root_identity: SnapshotWorkspaceIdentity,
    *,
    label: str,
) -> None:
    if workspace_identity(snapshot_root, label=label) != expected_root_identity:
        raise RuntimeError(f"{label} workspace changed: {snapshot_root}")


def _assert_portable_fallback_capabilities(*, label: str) -> None:
    missing: list[str] = []
    if not nofollow_hardlink_supported():
        missing.append("os.link(..., follow_symlinks=False)")
    if not nofollow_stat_supported():
        missing.append("os.stat(..., follow_symlinks=False)")
    if missing:
        raise RuntimeError(
            f"{label} cannot use pathname fallback safely on this platform; "
            "missing no-follow filesystem capability: " + ", ".join(missing)
        )


@contextmanager
def prepared_destination(
    snapshot_root: Path,
    relative_parts: tuple[str, ...],
    expected_root_identity: SnapshotWorkspaceIdentity,
    *,
    label: str,
) -> Iterator[tuple[Path, int | None, str, tuple[InternalParentIdentity, ...]]]:
    if not relative_parts or any(part in {"", ".", ".."} for part in relative_parts):
        raise AssertionError("execution snapshot relative path is malformed")

    destination = snapshot_root.joinpath(*relative_parts)
    leaf_name = relative_parts[-1]

    if component_walk_supported():
        opened: list[int] = []
        try:
            root_fd = os.open(snapshot_root, _open_flags())
            opened.append(root_fd)
            root_metadata = os.fstat(root_fd)
            if (
                not stat.S_ISDIR(root_metadata.st_mode)
                or (root_metadata.st_dev, root_metadata.st_ino) != expected_root_identity
            ):
                raise RuntimeError(f"{label} workspace changed: {snapshot_root}")

            current_fd = root_fd
            current_parts: list[str] = []
            parents: list[InternalParentIdentity] = []
            for component in relative_parts[:-1]:
                try:
                    os.mkdir(component, mode=0o700, dir_fd=current_fd)
                except FileExistsError:
                    pass
                child_fd = os.open(component, _open_flags(), dir_fd=current_fd)
                opened.append(child_fd)
                current_parts.append(component)
                parents.append(
                    _record_parent_identity(
                        tuple(current_parts),
                        os.fstat(child_fd),
                        label=label,
                    )
                )
                current_fd = child_fd

            yield destination, current_fd, leaf_name, tuple(parents)
        except OSError as error:
            raise RuntimeError(
                f"cannot prepare component-anchored {label} path: {destination}"
            ) from error
        finally:
            for fd in reversed(opened):
                try:
                    os.close(fd)
                except OSError:
                    pass
        return

    _assert_root_identity(snapshot_root, expected_root_identity, label=label)
    _assert_portable_fallback_capabilities(label=label)
    current = snapshot_root
    parents: list[InternalParentIdentity] = []
    for component in relative_parts[:-1]:
        current = current / component
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            pass
        try:
            metadata = os.lstat(current)
        except OSError as error:
            raise RuntimeError(f"{label} internal parent changed: {current}") from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise RuntimeError(f"{label} internal parent changed: {current}")
        parents.append(
            _record_parent_identity(
                tuple(relative_parts[: len(parents) + 1]),
                metadata,
                label=label,
            )
        )
    _assert_root_identity(snapshot_root, expected_root_identity, label=label)
    yield destination, None, leaf_name, tuple(parents)


def assert_parent_chain(
    snapshot_root: Path,
    expected_root_identity: SnapshotWorkspaceIdentity,
    parents: Sequence[InternalParentIdentity],
    *,
    label: str,
) -> None:
    if not parents:
        _assert_root_identity(snapshot_root, expected_root_identity, label=label)
        return

    if component_walk_supported():
        opened: list[int] = []
        try:
            root_fd = os.open(snapshot_root, _open_flags())
            opened.append(root_fd)
            root_metadata = os.fstat(root_fd)
            if (
                not stat.S_ISDIR(root_metadata.st_mode)
                or (root_metadata.st_dev, root_metadata.st_ino) != expected_root_identity
            ):
                raise RuntimeError(f"{label} workspace changed: {snapshot_root}")
            current_fd = root_fd
            previous_parts: tuple[str, ...] = ()
            for parts, expected_dev, expected_ino in parents:
                if len(parts) != len(previous_parts) + 1 or parts[:-1] != previous_parts:
                    raise AssertionError("execution snapshot internal parent chain is malformed")
                child_fd = os.open(parts[-1], _open_flags(), dir_fd=current_fd)
                opened.append(child_fd)
                metadata = os.fstat(child_fd)
                if (
                    not stat.S_ISDIR(metadata.st_mode)
                    or (metadata.st_dev, metadata.st_ino) != (expected_dev, expected_ino)
                ):
                    raise RuntimeError(f"{label} internal parent changed: {'/'.join(parts)}")
                current_fd = child_fd
                previous_parts = parts
        except OSError as error:
            raise RuntimeError(f"{label} internal parent changed") from error
        finally:
            for fd in reversed(opened):
                try:
                    os.close(fd)
                except OSError:
                    pass
        return

    _assert_root_identity(snapshot_root, expected_root_identity, label=label)
    _assert_portable_fallback_capabilities(label=label)
    for parts, expected_dev, expected_ino in parents:
        path = snapshot_root.joinpath(*parts)
        try:
            metadata = os.lstat(path)
        except OSError as error:
            raise RuntimeError(f"{label} internal parent changed: {path}") from error
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISDIR(metadata.st_mode)
            or (metadata.st_dev, metadata.st_ino) != (expected_dev, expected_ino)
        ):
            raise RuntimeError(f"{label} internal parent changed: {path}")


def unlink_pinned_destination(
    destination: Path,
    parent_fd: int | None,
    leaf_name: str,
) -> None:
    try:
        if parent_fd is not None:
            os.unlink(leaf_name, dir_fd=parent_fd)
        else:
            destination.unlink()
    except OSError:
        pass
