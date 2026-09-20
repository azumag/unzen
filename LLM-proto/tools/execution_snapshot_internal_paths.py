#!/usr/bin/env python3
"""Dependency-neutral helpers for execution-snapshot destination paths.

These helpers keep nested destination parent traversal anchored to directory
handles where the host supports ``dir_fd`` + ``O_NOFOLLOW`` and the
``follow_symlinks=False`` forms used by the anchored operations. Callers retain
file-specific provenance checks; this module owns only workspace/parent path
identity, verified workspace cleanup, and rollback mechanics.
"""

from __future__ import annotations

from contextlib import contextmanager
import errno
import os
from pathlib import Path
import stat
from typing import Iterator, Sequence


SnapshotWorkspaceIdentity = tuple[int, int]
InternalParentIdentity = tuple[tuple[str, ...], int, int]

MODE_COMPONENT_ANCHORED = "component-anchored"
MODE_PATHNAME_FALLBACK = "pathname-fallback"
MODE_UNSUPPORTED = "unsupported"

_REQUIRED_DIRECTORY_OPEN_FLAGS = ("O_RDONLY", "O_DIRECTORY", "O_NOFOLLOW")
_OPTIONAL_DIRECTORY_OPEN_FLAGS = ("O_CLOEXEC",)
_MISSING = object()


def _integer_flag(name: str, *, required: bool) -> bool:
    raw = getattr(os, name, _MISSING)
    if raw is _MISSING:
        return not required
    return type(raw) is int


def _directory_open_flags_supported() -> bool:
    if not all(
        _integer_flag(name, required=True)
        for name in _REQUIRED_DIRECTORY_OPEN_FLAGS
    ):
        return False
    return all(
        _integer_flag(name, required=False)
        for name in _OPTIONAL_DIRECTORY_OPEN_FLAGS
    )


def nofollow_hardlink_supported() -> bool:
    """Return whether ``os.link`` supports an explicit no-follow source contract."""

    link_fn = getattr(os, "link", None)
    if not callable(link_fn):
        return False
    supports_follow_symlinks = getattr(os, "supports_follow_symlinks", set())
    return link_fn in supports_follow_symlinks


def nofollow_stat_supported() -> bool:
    """Return whether ``os.stat`` supports explicit no-follow metadata reads."""

    stat_fn = getattr(os, "stat", None)
    if not callable(stat_fn):
        return False
    supports_follow_symlinks = getattr(os, "supports_follow_symlinks", set())
    return stat_fn in supports_follow_symlinks


def lstat_supported() -> bool:
    """Return whether pathname no-follow metadata reads are available."""

    return callable(getattr(os, "lstat", None))


def generation_bound_cleanup_supported() -> bool:
    """Return whether cleanup can stay anchored to opened directory generations."""

    open_fn = getattr(os, "open", None)
    stat_fn = getattr(os, "stat", None)
    fstat_fn = getattr(os, "fstat", None)
    scandir_fn = getattr(os, "scandir", None)
    unlink_fn = getattr(os, "unlink", None)
    rmdir_fn = getattr(os, "rmdir", None)
    close_fn = getattr(os, "close", None)
    if not all(
        callable(function)
        for function in (
            open_fn,
            stat_fn,
            fstat_fn,
            scandir_fn,
            unlink_fn,
            rmdir_fn,
            close_fn,
        )
    ):
        return False
    if not _directory_open_flags_supported():
        return False

    supports_dir_fd = getattr(os, "supports_dir_fd", set())
    supports_follow_symlinks = getattr(os, "supports_follow_symlinks", set())
    supports_fd = getattr(os, "supports_fd", set())
    return (
        open_fn in supports_dir_fd
        and stat_fn in supports_dir_fd
        and unlink_fn in supports_dir_fd
        and rmdir_fn in supports_dir_fd
        and stat_fn in supports_follow_symlinks
        and scandir_fn in supports_fd
    )


def component_walk_supported() -> bool:
    open_fn = getattr(os, "open", None)
    mkdir_fn = getattr(os, "mkdir", None)
    link_fn = getattr(os, "link", None)
    stat_fn = getattr(os, "stat", None)
    unlink_fn = getattr(os, "unlink", None)
    fstat_fn = getattr(os, "fstat", None)
    close_fn = getattr(os, "close", None)
    if not all(
        callable(function)
        for function in (
            open_fn,
            mkdir_fn,
            link_fn,
            stat_fn,
            unlink_fn,
            fstat_fn,
            close_fn,
        )
    ):
        return False
    if not _directory_open_flags_supported():
        return False

    supports_dir_fd = getattr(os, "supports_dir_fd", set())
    return (
        open_fn in supports_dir_fd
        and mkdir_fn in supports_dir_fd
        and link_fn in supports_dir_fd
        and stat_fn in supports_dir_fd
        and unlink_fn in supports_dir_fd
        and nofollow_hardlink_supported()
        and nofollow_stat_supported()
    )


def execution_snapshot_mode(
    *,
    component_anchored: bool,
    nofollow_hardlink: bool,
    pathname_lstat: bool,
) -> str:
    """Select the strongest safe execution-snapshot path mode."""

    if not pathname_lstat:
        return MODE_UNSUPPORTED
    if component_anchored:
        return MODE_COMPONENT_ANCHORED
    if nofollow_hardlink:
        return MODE_PATHNAME_FALLBACK
    return MODE_UNSUPPORTED


def assert_execution_snapshot_runtime_supported(*, label: str) -> str:
    """Fail closed before verification/workspace work on unsupported hosts.

    The standalone capability preflight and every public execution-snapshot
    runtime share ``execution_snapshot_mode`` so a direct runtime caller cannot
    proceed farther than the CLI gate would permit.
    """

    pathname_lstat = lstat_supported()
    component_anchored = component_walk_supported()
    nofollow_hardlink = nofollow_hardlink_supported()
    mode = execution_snapshot_mode(
        component_anchored=component_anchored,
        nofollow_hardlink=nofollow_hardlink,
        pathname_lstat=pathname_lstat,
    )
    if mode == MODE_UNSUPPORTED:
        if not pathname_lstat:
            raise RuntimeError(
                f"{label} requires os.lstat for no-follow pathname metadata"
            )
        raise RuntimeError(
            f"{label} pathname fallback requires "
            "os.link(..., follow_symlinks=False); refusing to use implicit symlink-follow semantics"
        )
    if not generation_bound_cleanup_supported():
        raise RuntimeError(
            f"{label} requires generation-bound workspace cleanup support"
        )
    return mode


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


def _cleanup_changed(label: str, path: Path) -> RuntimeError:
    return RuntimeError(f"{label} workspace changed before cleanup: {path}")


def _remove_open_directory_contents(
    directory_fd: int,
    *,
    label: str,
    workspace_path: Path,
) -> None:
    """Remove children through an already-open directory generation."""

    try:
        with os.scandir(directory_fd) as entries:
            names = [entry.name for entry in entries]
    except OSError as error:
        raise _cleanup_changed(label, workspace_path) from error

    for name in names:
        child_fd: int | None = None
        try:
            try:
                child_fd = os.open(name, _open_flags(), dir_fd=directory_fd)
            except OSError as error:
                if error.errno not in (errno.ENOTDIR, errno.ELOOP):
                    raise _cleanup_changed(label, workspace_path) from error
                try:
                    os.unlink(name, dir_fd=directory_fd)
                except OSError as unlink_error:
                    raise _cleanup_changed(label, workspace_path) from unlink_error
                continue

            try:
                child_metadata = os.fstat(child_fd)
            except OSError as error:
                raise _cleanup_changed(label, workspace_path) from error
            if not stat.S_ISDIR(child_metadata.st_mode):
                raise _cleanup_changed(label, workspace_path)
            child_identity = (child_metadata.st_dev, child_metadata.st_ino)

            _remove_open_directory_contents(
                child_fd,
                label=label,
                workspace_path=workspace_path,
            )

            try:
                current_metadata = os.stat(
                    name,
                    dir_fd=directory_fd,
                    follow_symlinks=False,
                )
            except OSError as error:
                raise _cleanup_changed(label, workspace_path) from error
            if (
                stat.S_ISLNK(current_metadata.st_mode)
                or not stat.S_ISDIR(current_metadata.st_mode)
                or (current_metadata.st_dev, current_metadata.st_ino) != child_identity
            ):
                raise _cleanup_changed(label, workspace_path)
            try:
                os.rmdir(name, dir_fd=directory_fd)
            except OSError as error:
                raise _cleanup_changed(label, workspace_path) from error
        finally:
            if child_fd is not None:
                try:
                    os.close(child_fd)
                except OSError:
                    pass


def remove_verified_workspace(
    path: Path,
    expected_identity: SnapshotWorkspaceIdentity,
    *,
    label: str,
) -> None:
    """Remove only the captured workspace generation, never a replacement tree."""

    if not generation_bound_cleanup_supported():
        raise RuntimeError(f"{label} requires generation-bound workspace cleanup support")

    parent_fd: int | None = None
    workspace_fd: int | None = None
    try:
        try:
            parent_fd = os.open(path.parent, _open_flags())
            workspace_fd = os.open(path.name, _open_flags(), dir_fd=parent_fd)
            metadata = os.fstat(workspace_fd)
        except OSError as error:
            raise _cleanup_changed(label, path) from error

        if (
            not stat.S_ISDIR(metadata.st_mode)
            or (metadata.st_dev, metadata.st_ino) != expected_identity
        ):
            raise _cleanup_changed(label, path)

        _remove_open_directory_contents(
            workspace_fd,
            label=label,
            workspace_path=path,
        )

        try:
            current_metadata = os.stat(
                path.name,
                dir_fd=parent_fd,
                follow_symlinks=False,
            )
        except OSError as error:
            raise _cleanup_changed(label, path) from error
        if (
            stat.S_ISLNK(current_metadata.st_mode)
            or not stat.S_ISDIR(current_metadata.st_mode)
            or (current_metadata.st_dev, current_metadata.st_ino) != expected_identity
        ):
            raise _cleanup_changed(label, path)
        try:
            os.rmdir(path.name, dir_fd=parent_fd)
        except OSError as error:
            raise _cleanup_changed(label, path) from error
    finally:
        for fd in (workspace_fd, parent_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass


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
    if not nofollow_hardlink_supported():
        raise RuntimeError(
            f"{label} cannot use pathname fallback safely on this platform; "
            "missing no-follow filesystem capability: os.link(..., follow_symlinks=False)"
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
