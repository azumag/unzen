#!/usr/bin/env python3
"""Pin legacy two-segment split artifacts for ONNX Runtime execution.

The legacy same-machine verifier predates the budgeted multi-segment artifact
verifier, but its prepared ``unzen-real-two-segment-onnx`` manifest already
records each segment graph digest plus per-segment external-data provenance.
This module binds those declarations to one hard-link execution tree so ORT
cannot observe a later pathname replacement and in-place mutation is detected
before numerical evidence is accepted.
"""

from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import stat
import tempfile
from typing import Iterator, Sequence

from verify_multi_segment_artifacts import (
    _canonical_sha256,
    _measure_file,
    _non_negative_int,
    _safe_relative_path_identity,
)


MANIFEST_SCHEMA_VERSION = "1.0.0"
MANIFEST_KIND = "unzen-real-two-segment-onnx"
ARTIFACT_LAYOUT = "per-segment-external-data"
ArtifactIdentity = tuple[int, int, int, int, int]
ArtifactFingerprint = tuple[int, int, int, int, int, int, int]
SnapshotWorkspaceIdentity = tuple[int, int]


def _regular_identity(path: Path, *, label: str) -> ArtifactIdentity:
    try:
        metadata = os.stat(path, follow_symlinks=False)
    except OSError as error:
        raise RuntimeError(f"{label} changed after legacy artifact preflight: {path}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError(f"{label} changed after legacy artifact preflight: {path}")
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _assert_requested_identity(
    requested: Path,
    resolved: Path,
    expected: ArtifactIdentity,
    *,
    label: str,
) -> None:
    try:
        observed_resolved = requested.resolve(strict=True)
    except OSError as error:
        raise RuntimeError(f"{label} changed after legacy artifact preflight: {requested}") from error
    if observed_resolved != resolved or _regular_identity(resolved, label=label) != expected:
        raise RuntimeError(f"{label} changed after legacy artifact preflight: {requested}")


def _artifact_fingerprint(path: Path, *, label: str) -> ArtifactFingerprint:
    try:
        metadata = os.stat(path, follow_symlinks=False)
    except OSError as error:
        raise RuntimeError(f"{label} changed during legacy split execution: {path}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError(f"{label} changed during legacy split execution: {path}")
    return (
        metadata.st_mode,
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _snapshot_workspace_identity(path: Path) -> SnapshotWorkspaceIdentity:
    try:
        metadata = os.stat(path, follow_symlinks=False)
    except OSError as error:
        raise RuntimeError(
            f"legacy artifact execution snapshot workspace changed before cleanup: {path}"
        ) from error
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(
            f"legacy artifact execution snapshot workspace changed before cleanup: {path}"
        )
    return metadata.st_dev, metadata.st_ino


def _remove_verified_snapshot_root(
    snapshot_root: Path,
    expected_identity: SnapshotWorkspaceIdentity,
) -> None:
    if _snapshot_workspace_identity(snapshot_root) != expected_identity:
        raise RuntimeError(
            f"legacy artifact execution snapshot workspace changed before cleanup: {snapshot_root}"
        )
    shutil.rmtree(snapshot_root)


def _validate_manifest_header(manifest: dict[str, object]) -> None:
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise ValueError(
            f"unexpected split manifest schemaVersion: {manifest.get('schemaVersion')!r}"
        )
    if manifest.get("kind") != MANIFEST_KIND:
        raise ValueError(f"unexpected split manifest kind: {manifest.get('kind')!r}")
    if manifest.get("artifactLayout") != ARTIFACT_LAYOUT:
        raise ValueError(
            "legacy numerical verification requires per-segment external data; "
            f"got {manifest.get('artifactLayout')!r}"
        )


def _artifact_entries(
    manifest_path: Path,
    manifest: dict[str, object],
    cli_segment_paths: Sequence[Path],
) -> tuple[dict[str, object], ...]:
    _validate_manifest_header(manifest)
    if len(cli_segment_paths) != 2:
        raise ValueError("legacy numerical verification requires exactly two segment paths")

    raw_segments = manifest.get("segments")
    if not isinstance(raw_segments, list) or len(raw_segments) != 2:
        raise ValueError("legacy split manifest must contain exactly two segments")

    root = manifest_path.expanduser().absolute().parent.resolve(strict=True)
    entries: list[dict[str, object]] = []
    seen_resolved: dict[Path, str] = {}
    seen_objects: dict[tuple[int, int], str] = {}
    portable_paths: dict[str, str] = {}

    def add_entry(
        *,
        field: str,
        relative_raw: object,
        expected_sha_raw: object,
        expected_bytes_raw: object | None,
    ) -> dict[str, object]:
        requested, resolved = _safe_relative_path_identity(root, relative_raw, field=field)
        relative = requested.relative_to(root).as_posix()
        portable = relative.lower()
        previous_portable = portable_paths.get(portable)
        if previous_portable is not None and previous_portable != relative:
            raise ValueError(f"portable case alias declared legacy artifact path: {field}")
        previous = seen_resolved.get(resolved)
        if previous is not None:
            raise ValueError(f"duplicate declared legacy artifact path: {field} aliases {previous}")

        expected_sha = _canonical_sha256(expected_sha_raw, field=f"{field}.sha256")
        expected_bytes = None
        if expected_bytes_raw is not None:
            expected_bytes = _non_negative_int(expected_bytes_raw, field=f"{field}.bytes")

        observed_bytes, observed_sha = _measure_file(
            requested,
            missing_message=f"legacy split artifact not found: {requested}",
            expected_resolved=resolved,
        )
        if observed_sha != expected_sha:
            raise ValueError(
                f"legacy split artifact SHA-256 mismatch for {field}: "
                f"expected={expected_sha}, observed={observed_sha}"
            )
        if expected_bytes is not None and observed_bytes != expected_bytes:
            raise ValueError(
                f"legacy split artifact size mismatch for {field}: "
                f"expected={expected_bytes}, observed={observed_bytes}"
            )

        identity = _regular_identity(resolved, label=field)
        object_key = identity[0], identity[1]
        previous_object = seen_objects.get(object_key)
        if previous_object is not None:
            raise ValueError(
                f"legacy split artifact hard-link alias: {field} aliases {previous_object}"
            )

        seen_resolved[resolved] = field
        seen_objects[object_key] = field
        portable_paths[portable] = relative
        entry = {
            "field": field,
            "relative": relative,
            "requested": requested,
            "resolved": resolved,
            "identity": identity,
        }
        entries.append(entry)
        return entry

    for expected_index, raw_segment in enumerate(raw_segments):
        if not isinstance(raw_segment, dict):
            raise ValueError(f"segments[{expected_index}] must be an object")
        index = _non_negative_int(
            raw_segment.get("index"), field=f"segments[{expected_index}].index"
        )
        if index != expected_index:
            raise ValueError(
                f"legacy segment indices must be 0 and 1; expected {expected_index}, got {index}"
            )

        graph = add_entry(
            field=f"segments[{index}].path",
            relative_raw=raw_segment.get("path"),
            expected_sha_raw=raw_segment.get("sha256"),
            expected_bytes_raw=None,
        )
        cli_path = cli_segment_paths[index].expanduser().absolute()
        try:
            cli_resolved = cli_path.resolve(strict=True)
        except OSError as error:
            raise FileNotFoundError(f"segment {index} not found: {cli_path}") from error
        if cli_resolved != graph["resolved"]:
            raise ValueError(
                f"--segment{index} does not resolve to manifest segments[{index}].path: "
                f"cli={cli_path}, manifest={graph['requested']}"
            )

        raw_external = raw_segment.get("externalData")
        if not isinstance(raw_external, list):
            raise ValueError(f"segments[{index}].externalData must be an array")
        for external_index, raw_entry in enumerate(raw_external):
            if not isinstance(raw_entry, dict):
                raise ValueError(
                    f"segments[{index}].externalData[{external_index}] must be an object"
                )
            prefix = f"segments[{index}].externalData[{external_index}]"
            add_entry(
                field=prefix,
                relative_raw=raw_entry.get("location"),
                expected_sha_raw=raw_entry.get("sha256"),
                expected_bytes_raw=raw_entry.get("bytes"),
            )

    return tuple(entries)


def _link_verified_file(entry: dict[str, object], snapshot_root: Path) -> Path:
    field = str(entry["field"])
    requested = entry["requested"]
    resolved = entry["resolved"]
    expected = entry["identity"]
    relative = entry["relative"]
    if (
        not isinstance(requested, Path)
        or not isinstance(resolved, Path)
        or not isinstance(expected, tuple)
        or not isinstance(relative, str)
    ):
        raise AssertionError("internal legacy artifact entry is malformed")

    _assert_requested_identity(requested, resolved, expected, label=field)
    destination = snapshot_root / Path(relative)
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(resolved, destination, follow_symlinks=False)
    except OSError as error:
        raise RuntimeError(
            f"cannot create hard-link execution snapshot for {field}: {resolved}; "
            "legacy segment graphs and external data must support hard links on the snapshot filesystem; "
            "refusing to duplicate large payload bytes"
        ) from error

    linked = _regular_identity(destination, label=field)
    if linked != expected:
        raise RuntimeError(
            f"{field} changed while legacy execution snapshot was being pinned: {resolved}"
        )
    _assert_requested_identity(requested, resolved, expected, label=field)
    return destination


def _capture_fingerprints(
    entries: Sequence[dict[str, object]],
    snapshot_root: Path,
) -> tuple[tuple[str, Path, ArtifactFingerprint], ...]:
    captured: list[tuple[str, Path, ArtifactFingerprint]] = []
    for entry in entries:
        field = str(entry["field"])
        relative = entry["relative"]
        if not isinstance(relative, str):
            raise AssertionError("internal legacy artifact relative path is malformed")
        path = snapshot_root / Path(relative)
        captured.append((field, path, _artifact_fingerprint(path, label=field)))
    return tuple(captured)


def _assert_fingerprints(
    captured: Sequence[tuple[str, Path, ArtifactFingerprint]],
) -> None:
    for field, path, expected in captured:
        if _artifact_fingerprint(path, label=field) != expected:
            raise RuntimeError(f"{field} changed during legacy split execution: {path}")


@contextmanager
def verified_legacy_two_segment_execution_snapshot(
    manifest_path: Path,
    manifest: dict[str, object],
    segment0_path: Path,
    segment1_path: Path,
) -> Iterator[tuple[Path, Path]]:
    """Yield manifest-bound hard-link paths for the two legacy ORT sessions."""

    manifest_path = manifest_path.expanduser().absolute()
    entries = _artifact_entries(
        manifest_path,
        manifest,
        (segment0_path, segment1_path),
    )

    snapshot_parent = manifest_path.parent.resolve(strict=True)
    try:
        snapshot_root = Path(
            tempfile.mkdtemp(
                prefix=".unzen-legacy-two-segment-execution-",
                dir=snapshot_parent,
            )
        ).resolve(strict=True)
        snapshot_root_identity = _snapshot_workspace_identity(snapshot_root)
    except (OSError, RuntimeError) as error:
        raise RuntimeError(
            f"cannot create legacy artifact execution snapshot beside split manifest: {manifest_path}"
        ) from error

    try:
        destinations: dict[str, Path] = {}
        for entry in entries:
            destination = _link_verified_file(entry, snapshot_root)
            destinations[str(entry["field"])] = destination

        fingerprints = _capture_fingerprints(entries, snapshot_root)
        graph0 = destinations["segments[0].path"]
        graph1 = destinations["segments[1].path"]
        yield graph0, graph1
        _assert_fingerprints(fingerprints)
    finally:
        _remove_verified_snapshot_root(snapshot_root, snapshot_root_identity)
