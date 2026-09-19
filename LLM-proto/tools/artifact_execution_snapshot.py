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
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
from typing import Iterator, Sequence

from verify_multi_segment_artifact_snapshot import (
    PATH_RESOLUTION_COMPONENT_ANCHORED,
    PATH_RESOLUTION_FINAL_ONLY,
    REPORT_KIND,
    REPORT_SCHEMA_VERSION,
    _assert_directory_anchor,
    _assert_distinct_file_identities,
    _component_walk_supported,
    _declared_files,
    _identity,
    _measure_all,
    _open_directory_anchor,
    _preflight_distinct_file_identities,
    _read_manifest,
)
from verify_multi_segment_artifacts import verify_artifact_integrity


ArtifactFingerprint = tuple[int, int, int, int, int, int, int]
SnapshotWorkspaceIdentity = tuple[int, int]


def _verify_execution_boundary(
    manifest_path: Path,
) -> tuple[dict[str, object], bytes, tuple[dict[str, object], ...]]:
    """Run the stable artifact verification and retain accepted file identities."""

    manifest_path = manifest_path.expanduser().absolute()
    root = manifest_path.parent.resolve()
    root_fd: int | None = None
    root_opened: os.stat_result | None = None
    path_resolution_mode = PATH_RESOLUTION_FINAL_ONLY
    if _component_walk_supported():
        root_fd, root_opened = _open_directory_anchor(root)
        path_resolution_mode = PATH_RESOLUTION_COMPONENT_ANCHORED

    try:
        manifest_bytes, manifest_identity = _read_manifest(manifest_path, root_fd=root_fd)
        try:
            manifest = json.loads(manifest_bytes.decode("utf-8", errors="strict"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("split manifest must contain valid UTF-8 JSON") from error
        if not isinstance(manifest, dict):
            raise ValueError("split manifest must contain a JSON object")

        manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
        declared = _declared_files(manifest, root)
        _preflight_distinct_file_identities(declared, root_fd=root_fd)
        before = _measure_all(declared, root_fd=root_fd)
        _assert_distinct_file_identities(before)

        integrity_manifest = root / manifest_path.name if root_fd is not None else manifest_path
        integrity = verify_artifact_integrity(integrity_manifest)
        if integrity.get("status") != "pass":
            raise RuntimeError("underlying artifact integrity verification did not pass")
        if integrity.get("manifestSha256") != manifest_sha:
            raise ValueError("underlying verifier observed a different manifest snapshot")
        if root_opened is not None:
            _assert_directory_anchor(root, root_opened)

        after_bytes, after_identity = _read_manifest(manifest_path, root_fd=root_fd)
        if (
            after_identity != manifest_identity
            or hashlib.sha256(after_bytes).hexdigest() != manifest_sha
        ):
            raise ValueError("split manifest changed across artifact integrity verification")

        after = _measure_all(declared, root_fd=root_fd)
        for old, new in zip(before, after, strict=True):
            if old["parentIdentities"] != new["parentIdentities"]:
                raise ValueError(
                    "declared artifact parent directory changed across artifact integrity verification: "
                    f"{old['field']} ({old['path']})"
                )
            if (
                old["identity"] != new["identity"]
                or old["bytes"] != new["bytes"]
                or old["sha256"] != new["sha256"]
            ):
                raise ValueError(
                    "declared artifact changed across artifact integrity verification: "
                    f"{old['field']} ({old['path']})"
                )
        if root_opened is not None:
            _assert_directory_anchor(root, root_opened)

        public = [
            {
                "field": item["field"],
                "path": item["path"],
                "bytes": item["bytes"],
                "sha256": item["sha256"],
            }
            for item in before
        ]
        report = {
            "schemaVersion": REPORT_SCHEMA_VERSION,
            "kind": REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "pathResolutionMode": path_resolution_mode,
            "manifestSha256": manifest_sha,
            "segmentCount": integrity.get("segmentCount"),
            "artifactFileCount": len(public),
            "artifacts": public,
            "integrity": integrity,
        }
        return report, manifest_bytes, tuple(before)
    finally:
        if root_fd is not None:
            os.close(root_fd)


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


def _link_verified_artifact_file(
    entry: dict[str, object],
    destination_path: Path,
) -> None:
    source_path = _entry_path(entry)
    field = str(entry.get("field"))
    expected = _accepted_identity(entry)
    expected_object = expected[0], expected[1]
    _assert_accepted_artifact_path(entry)
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source_path, destination_path, follow_symlinks=False)
    except OSError as error:
        raise RuntimeError(
            f"cannot create hard-link execution snapshot for {field}: {source_path}; "
            "generated graphs and external data must support hard links on the snapshot filesystem; "
            "refusing to duplicate large payload bytes"
        ) from error

    try:
        linked = os.stat(destination_path, follow_symlinks=False)
        current = os.lstat(source_path)
    except OSError as error:
        raise RuntimeError(
            f"artifact changed while execution snapshot was being pinned: {field} ({source_path})"
        ) from error
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


def _artifact_execution_fingerprint(path: Path, *, label: str) -> ArtifactFingerprint:
    try:
        metadata = os.stat(path, follow_symlinks=False)
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


def _snapshot_workspace_identity(path: Path) -> SnapshotWorkspaceIdentity:
    try:
        metadata = os.stat(path, follow_symlinks=False)
    except OSError as error:
        raise RuntimeError(
            f"artifact execution snapshot workspace changed before cleanup: {path}"
        ) from error
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(
            f"artifact execution snapshot workspace changed before cleanup: {path}"
        )
    return metadata.st_dev, metadata.st_ino


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
        snapshot_manifest = snapshot_root / manifest_path.name
        snapshot_manifest.write_bytes(manifest_bytes)

        for entry in entries:
            relative = entry.get("path")
            if not isinstance(relative, str) or not relative:
                raise AssertionError("internal artifact relative path must be a non-empty string")
            _link_verified_artifact_file(entry, snapshot_root / Path(relative))

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
        _assert_execution_fingerprints(fingerprints)
    finally:
        _remove_verified_snapshot_root(snapshot_root, snapshot_root_identity)
