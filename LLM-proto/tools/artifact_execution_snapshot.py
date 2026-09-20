#!/usr/bin/env python3
"""Pin verified multi-segment artifacts for ONNX Runtime execution.

The stable artifact verifier proves that one manifest generation and every
manifest-declared graph/external-data file stay stable across integrity
verification. This module immediately binds those accepted file identities into
a temporary hard-link tree and keeps metadata fingerprints alive through ORT
execution, so numerical evidence is not produced from a later pathname
replacement or in-place mutation.
"""

from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import stat
import tempfile
from typing import Iterator, Sequence

import execution_snapshot_internal_paths as execution_snapshot_paths
from verify_multi_segment_artifact_snapshot import (
    _identity,
    _verify_artifact_snapshot_stable,
)


ArtifactFingerprint = tuple[int, int, int, int, int, int, int]
SnapshotWorkspaceIdentity = execution_snapshot_paths.SnapshotWorkspaceIdentity
InternalParentIdentity = execution_snapshot_paths.InternalParentIdentity
_ARTIFACT_SNAPSHOT_LABEL = "artifact execution snapshot"


def _verify_execution_boundary(
    manifest_path: Path,
) -> tuple[dict[str, object], bytes, tuple[dict[str, object], ...]]:
    """Run the shared stable verification and retain accepted file identities."""

    return _verify_artifact_snapshot_stable(manifest_path)


def _accepted_identity(entry: dict[str, object]) -> tuple[int, int, int, int, int]:
    raw = entry.get("identity")
    if (
        not isinstance(raw, tuple)
        or len(raw) != 5
        or not all(isinstance(value, int) for value in raw)
    ):
        raise AssertionError("internal artifact identity must contain five integers")
    return raw


def _entry_path(entry: dict[str, object]) -> Path:
    raw = entry.get("absolute")
    if not isinstance(raw, Path):
        raise AssertionError("internal artifact absolute path must be a Path")
    return raw


def _entry_relative_parts(entry: dict[str, object]) -> tuple[str, ...]:
    raw = entry.get("path")
    if not isinstance(raw, str) or not raw:
        raise AssertionError("internal artifact relative path must be a non-empty string")
    relative = Path(raw)
    if relative.is_absolute() or not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise AssertionError("internal artifact relative path must stay beneath the snapshot root")
    return tuple(relative.parts)


def _assert_accepted_artifact_path(entry: dict[str, object]) -> None:
    path = _entry_path(entry)
    field = str(entry.get("field"))
    expected = _accepted_identity(entry)
    try:
        current = os.lstat(path)
    except OSError as error:
        raise RuntimeError(
            f"{field} changed after artifact-snapshot preflight: {path}"
        ) from error
    if stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode):
        raise RuntimeError(f"{field} changed after artifact-snapshot preflight: {path}")
    if _identity(current) != expected:
        raise RuntimeError(f"{field} changed after artifact-snapshot preflight: {path}")


def _internal_component_walk_supported() -> bool:
    return execution_snapshot_paths.component_walk_supported()


def _pathname_hard_link_supported() -> bool:
    return execution_snapshot_paths.nofollow_hardlink_supported()


def _require_pathname_hard_link_support() -> None:
    if _pathname_hard_link_supported():
        return
    raise RuntimeError(
        "artifact execution snapshot pathname fallback requires "
        "os.link(..., follow_symlinks=False); refusing to use implicit symlink-follow semantics"
    )


def _snapshot_create_flags() -> int:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    return flags


def _snapshot_workspace_identity(path: Path) -> SnapshotWorkspaceIdentity:
    return execution_snapshot_paths.workspace_identity(
        path,
        label=_ARTIFACT_SNAPSHOT_LABEL,
    )


@contextmanager
def _prepared_snapshot_destination(
    snapshot_root: Path,
    relative_parts: tuple[str, ...],
    expected_root_identity: SnapshotWorkspaceIdentity,
) -> Iterator[tuple[Path, int | None, str, tuple[InternalParentIdentity, ...]]]:
    with execution_snapshot_paths.prepared_destination(
        snapshot_root,
        relative_parts,
        expected_root_identity,
        label=_ARTIFACT_SNAPSHOT_LABEL,
    ) as prepared:
        yield prepared


def _assert_internal_parent_chain(
    snapshot_root: Path,
    expected_root_identity: SnapshotWorkspaceIdentity,
    parents: Sequence[InternalParentIdentity],
) -> None:
    try:
        execution_snapshot_paths.assert_parent_chain(
            snapshot_root,
            expected_root_identity,
            parents,
            label=_ARTIFACT_SNAPSHOT_LABEL,
        )
    except RuntimeError as error:
        marker = f"{_ARTIFACT_SNAPSHOT_LABEL} internal parent changed"
        message = str(error)
        if message.startswith(marker):
            raise RuntimeError(
                f"{marker} during pinning{message[len(marker):]}"
            ) from error
        raise


def _unlink_pinned_destination(
    destination: Path,
    parent_fd: int | None,
    leaf_name: str,
) -> None:
    execution_snapshot_paths.unlink_pinned_destination(
        destination,
        parent_fd,
        leaf_name,
    )


def _write_snapshot_manifest(
    snapshot_root: Path,
    expected_root_identity: SnapshotWorkspaceIdentity,
    manifest_name: str,
    manifest_bytes: bytes,
) -> Path:
    with _prepared_snapshot_destination(
        snapshot_root,
        (manifest_name,),
        expected_root_identity,
    ) as (destination, parent_fd, leaf_name, parent_chain):
        if parent_chain:
            raise AssertionError("snapshot manifest must live at the workspace root")
        fd: int | None = None
        try:
            if parent_fd is not None:
                fd = os.open(
                    leaf_name,
                    _snapshot_create_flags(),
                    0o600,
                    dir_fd=parent_fd,
                )
            else:
                fd = os.open(destination, _snapshot_create_flags(), 0o600)
            offset = 0
            while offset < len(manifest_bytes):
                written = os.write(fd, manifest_bytes[offset:])
                if written <= 0:
                    raise OSError("snapshot manifest write made no progress")
                offset += written
        except Exception:
            _unlink_pinned_destination(destination, parent_fd, leaf_name)
            raise
        finally:
            if fd is not None:
                os.close(fd)
        _assert_internal_parent_chain(
            snapshot_root,
            expected_root_identity,
            parent_chain,
        )
        return destination


def _link_verified_artifact_file(
    entry: dict[str, object],
    destination_path: Path,
    expected_root_identity: SnapshotWorkspaceIdentity | None = None,
) -> None:
    source_path = _entry_path(entry)
    field = str(entry.get("field"))
    expected = _accepted_identity(entry)
    expected_object = expected[0], expected[1]
    relative_parts = _entry_relative_parts(entry)
    snapshot_root = destination_path
    for _ in relative_parts:
        snapshot_root = snapshot_root.parent
    if expected_root_identity is None:
        expected_root_identity = _snapshot_workspace_identity(snapshot_root)

    with _prepared_snapshot_destination(
        snapshot_root,
        relative_parts,
        expected_root_identity,
    ) as (destination, parent_fd, leaf_name, parent_chain):
        entry["_snapshotParentIdentities"] = parent_chain
        _assert_accepted_artifact_path(entry)
        try:
            if parent_fd is not None:
                os.link(
                    source_path,
                    leaf_name,
                    dst_dir_fd=parent_fd,
                    follow_symlinks=False,
                )
            else:
                _require_pathname_hard_link_support()
                os.link(source_path, destination, follow_symlinks=False)
        except (OSError, NotImplementedError) as error:
            raise RuntimeError(
                f"cannot create hard-link execution snapshot for {field}: {source_path}; "
                "generated graphs and external data must support hard links on the snapshot filesystem; "
                "refusing to duplicate large payload bytes"
            ) from error

        try:
            _assert_internal_parent_chain(
                snapshot_root,
                expected_root_identity,
                parent_chain,
            )
            if parent_fd is not None:
                linked = os.stat(leaf_name, dir_fd=parent_fd, follow_symlinks=False)
            else:
                linked = os.lstat(destination)
            current = os.lstat(source_path)
            if (
                not stat.S_ISREG(linked.st_mode)
                or not stat.S_ISREG(current.st_mode)
                or (linked.st_dev, linked.st_ino) != expected_object
                or (current.st_dev, current.st_ino) != expected_object
                or linked.st_size != expected[2]
                or linked.st_mtime_ns != expected[3]
                or current.st_size != expected[2]
                or current.st_mtime_ns != expected[3]
            ):
                raise RuntimeError(
                    f"artifact changed while execution snapshot was being pinned: {field} ({source_path})"
                )
            _assert_internal_parent_chain(
                snapshot_root,
                expected_root_identity,
                parent_chain,
            )
        except Exception:
            _unlink_pinned_destination(destination, parent_fd, leaf_name)
            raise


def _artifact_execution_fingerprint(path: Path, *, label: str) -> ArtifactFingerprint:
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise RuntimeError(f"{label} changed during numerical execution: {path}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError(f"{label} changed during numerical execution: {path}")
    return (
        metadata.st_mode,
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _capture_execution_fingerprints(
    entries: Sequence[dict[str, object]],
    snapshot_root: Path,
) -> tuple[tuple[str, Path, ArtifactFingerprint], ...]:
    captured: list[tuple[str, Path, ArtifactFingerprint]] = []
    for entry in entries:
        relative = entry.get("path")
        if not isinstance(relative, str) or not relative:
            raise AssertionError("internal artifact relative path must be a non-empty string")
        path = snapshot_root / Path(relative)
        label = str(entry.get("field"))
        captured.append((label, path, _artifact_execution_fingerprint(path, label=label)))
    return tuple(captured)


def _assert_execution_fingerprints(
    captured: Sequence[tuple[str, Path, ArtifactFingerprint]],
) -> None:
    for label, path, expected in captured:
        observed = _artifact_execution_fingerprint(path, label=label)
        if observed != expected:
            raise RuntimeError(f"{label} changed during numerical execution: {path}")


def _assert_recorded_internal_parents(
    entries: Sequence[dict[str, object]],
    snapshot_root: Path,
    expected_root_identity: SnapshotWorkspaceIdentity,
) -> None:
    for entry in entries:
        raw = entry.get("_snapshotParentIdentities")
        if raw is None:
            continue
        if not isinstance(raw, tuple):
            raise AssertionError("internal artifact snapshot parent identities are malformed")
        chain: list[InternalParentIdentity] = []
        for item in raw:
            if (
                not isinstance(item, tuple)
                or len(item) != 3
                or not isinstance(item[0], tuple)
                or not all(isinstance(part, str) for part in item[0])
                or not isinstance(item[1], int)
                or not isinstance(item[2], int)
            ):
                raise AssertionError("internal artifact snapshot parent identity is malformed")
            chain.append((item[0], item[1], item[2]))
        _assert_internal_parent_chain(snapshot_root, expected_root_identity, tuple(chain))


def _remove_verified_snapshot_root(
    snapshot_root: Path,
    expected_identity: SnapshotWorkspaceIdentity,
) -> None:
    observed_identity = _snapshot_workspace_identity(snapshot_root)
    if observed_identity != expected_identity:
        raise RuntimeError(
            f"artifact execution snapshot workspace changed before cleanup: {snapshot_root}"
        )
    shutil.rmtree(snapshot_root)


@contextmanager
def verified_artifact_execution_snapshot(
    manifest_path: Path,
) -> Iterator[tuple[dict[str, object], Path]]:
    """Yield the verified report and a manifest rooted in a pinned hard-link tree."""

    execution_snapshot_paths.assert_execution_snapshot_runtime_supported(
        label=_ARTIFACT_SNAPSHOT_LABEL
    )

    manifest_path = manifest_path.expanduser().absolute()
    report, manifest_bytes, entries = _verify_execution_boundary(manifest_path)

    try:
        snapshot_parent = manifest_path.parent.resolve(strict=True)
        snapshot_root = Path(
            tempfile.mkdtemp(
                prefix=".unzen-artifact-execution-",
                dir=snapshot_parent,
            )
        ).resolve(strict=True)
        snapshot_root_identity = _snapshot_workspace_identity(snapshot_root)
    except (OSError, RuntimeError) as error:
        raise RuntimeError(
            f"cannot create artifact execution snapshot beside split manifest: {manifest_path}"
        ) from error

    try:
        snapshot_manifest = _write_snapshot_manifest(
            snapshot_root,
            snapshot_root_identity,
            manifest_path.name,
            manifest_bytes,
        )

        for entry in entries:
            relative = entry.get("path")
            if not isinstance(relative, str) or not relative:
                raise AssertionError("internal artifact relative path must be a non-empty string")
            _link_verified_artifact_file(
                entry,
                snapshot_root / Path(relative),
                snapshot_root_identity,
            )

        _assert_recorded_internal_parents(entries, snapshot_root, snapshot_root_identity)
        for entry in entries:
            source_path = _entry_path(entry)
            expected = _accepted_identity(entry)
            try:
                current = os.lstat(source_path)
            except OSError as error:
                raise RuntimeError(
                    f"{entry.get('field')} changed after execution snapshot pinning: {source_path}"
                ) from error
            if (
                stat.S_ISLNK(current.st_mode)
                or not stat.S_ISREG(current.st_mode)
                or (current.st_dev, current.st_ino) != (expected[0], expected[1])
                or current.st_size != expected[2]
                or current.st_mtime_ns != expected[3]
            ):
                raise RuntimeError(
                    f"{entry.get('field')} changed after execution snapshot pinning: {source_path}"
                )

        fingerprints = _capture_execution_fingerprints(entries, snapshot_root)
        yield report, snapshot_manifest
        _assert_recorded_internal_parents(entries, snapshot_root, snapshot_root_identity)
        _assert_execution_fingerprints(fingerprints)
    finally:
        _assert_recorded_internal_parents(entries, snapshot_root, snapshot_root_identity)
        _remove_verified_snapshot_root(snapshot_root, snapshot_root_identity)
