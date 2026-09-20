#!/usr/bin/env python3
"""Dependency-neutral verified source-model execution snapshots.

The helpers in this module bind a full-model ONNX Runtime load to the exact
source graph/external-data generation accepted by manifest provenance checks.
They intentionally avoid importing either verifier entry point so legacy and
multi-segment verifiers can depend on the boundary without forming an import
cycle.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import tempfile
from typing import Iterator, Sequence

from execution_snapshot_internal_paths import (
    InternalParentIdentity,
    assert_parent_chain,
    prepared_destination,
    unlink_pinned_destination,
)
from verify_multi_segment_artifacts import SHA256_RE, _measure_file


WINDOWS_RESERVED_DEVICE_STEMS = {"CON", "PRN", "AUX", "NUL"}
WINDOWS_RESERVED_PORT_RE = re.compile(r"^(?:COM|LPT)(?:[1-9]|[¹²³])$")
ASCII_CASE_FOLD = str.maketrans(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
)

SourceExternalContract = tuple[str, Path, Path, int, str]
SourceFingerprint = tuple[int, int, int, int, int, int, int]
SnapshotWorkspaceIdentity = tuple[int, int]
SourceSnapshotLinkContext = tuple[
    Path,
    SnapshotWorkspaceIdentity,
    list[tuple[InternalParentIdentity, ...]],
]
_SOURCE_SNAPSHOT_LINK_CONTEXT: ContextVar[SourceSnapshotLinkContext | None] = ContextVar(
    "source_snapshot_link_context",
    default=None,
)


def _unsafe_windows_component(part: str) -> bool:
    if part.endswith((".", " ")):
        return True
    stem = part.split(".", 1)[0].upper()
    return stem in WINDOWS_RESERVED_DEVICE_STEMS or bool(
        WINDOWS_RESERVED_PORT_RE.fullmatch(stem)
    )


def _non_empty_string(raw: object, *, field: str) -> str:
    if not isinstance(raw, str) or not raw:
        raise ValueError(f"{field} must be a non-empty string")
    return raw


def _canonical_sha256(raw: object, *, field: str) -> str:
    value = _non_empty_string(raw, field=field)
    if not SHA256_RE.fullmatch(value):
        raise ValueError(f"{field} must be a canonical lowercase SHA-256 digest")
    return value


def _source_external_location(raw: object, *, field: str) -> str:
    value = _non_empty_string(raw, field=field)
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise ValueError(f"unsafe {field} in split manifest: {value}")
    lexical_parts = re.split(r"[\\/]", value)
    if any(part in {"", "."} for part in lexical_parts):
        raise ValueError(f"unsafe {field} in split manifest: {value}")
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or bool(windows.drive)
        or bool(windows.root)
        or any(":" in part for part in windows.parts)
        or any(_unsafe_windows_component(part) for part in windows.parts)
        or ".." in posix.parts
        or ".." in windows.parts
    ):
        raise ValueError(f"unsafe {field} in split manifest: {value}")
    return value


def _safe_relative_path(root: Path, raw: object, *, field: str) -> Path:
    value = _non_empty_string(raw, field=field)
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or bool(windows.drive)
        or bool(windows.root)
        or any(":" in part for part in windows.parts)
        or any(_unsafe_windows_component(part) for part in windows.parts)
        or ".." in posix.parts
        or ".." in windows.parts
    ):
        raise ValueError(f"unsafe {field} in split manifest: {value}")
    resolved_root = root.resolve()
    resolved = (root / Path(value)).resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise ValueError(f"{field} escapes split manifest directory: {value}")
    return resolved


def _non_negative_int(raw: object, *, field: str) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return raw


def _source_file_identity(
    path: Path,
    *,
    field: str,
    missing_message: str,
) -> tuple[int, int]:
    try:
        metadata = path.stat()
    except FileNotFoundError:
        raise FileNotFoundError(missing_message) from None
    except OSError as error:
        raise ValueError(f"{field} is not readable: {path}: {error}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"artifact must be a regular file ({field}): {path}")
    return metadata.st_dev, metadata.st_ino


def _preflight_source_file_identities(
    full_model_path: Path,
    external_contract: Sequence[SourceExternalContract],
) -> tuple[tuple[int, int], tuple[tuple[int, int], ...]]:
    seen: dict[tuple[int, int], str] = {}
    graph_identity = _source_file_identity(
        full_model_path,
        field="source graph",
        missing_message=f"full model not found: {full_model_path}",
    )
    seen[graph_identity] = "source graph"
    external_identities: list[tuple[int, int]] = []

    for location, _, external_resolved, _, _ in external_contract:
        identity = _source_file_identity(
            external_resolved,
            field=f"source external data {location}",
            missing_message=f"source external data not found: {external_resolved}",
        )
        previous = seen.get(identity)
        if previous is not None:
            raise ValueError(
                "source provenance hard-link alias: "
                f"{location} aliases {previous}"
            )
        seen[identity] = location
        external_identities.append(identity)

    return graph_identity, tuple(external_identities)


def _preflight_source_model_identity(
    full_model_path: Path,
    manifest: dict[str, object],
) -> tuple[str, Path, tuple[SourceExternalContract, ...]]:
    raw_source = manifest.get("sourceModel")
    if not isinstance(raw_source, dict):
        raise ValueError("split manifest sourceModel must be an object")

    expected_graph_sha = _canonical_sha256(
        raw_source.get("sha256"),
        field="sourceModel.sha256",
    )
    raw_external = raw_source.get("externalData")
    if not isinstance(raw_external, list):
        raise ValueError("sourceModel.externalData must be an array")

    external_contract: list[SourceExternalContract] = []
    source_graph_path = full_model_path.resolve()
    seen_paths: dict[Path, str] = {source_graph_path: "source graph"}
    seen_locations: set[str] = set()
    portable_case_seen: dict[str, str] = {}
    portable_separator_seen: dict[str, str] = {}
    for index, raw_entry in enumerate(raw_external):
        if not isinstance(raw_entry, dict):
            raise ValueError(f"sourceModel.externalData[{index}] must be an object")
        field_prefix = f"sourceModel.externalData[{index}]"
        location = _source_external_location(
            raw_entry.get("location"),
            field=f"{field_prefix}.location",
        )
        if location in seen_locations:
            raise ValueError(
                "duplicate source external-data location: "
                f"{location} aliases {location}"
            )
        portable_case_location = location.translate(ASCII_CASE_FOLD)
        previous_case_location = portable_case_seen.get(portable_case_location)
        if previous_case_location is not None:
            raise ValueError(
                "portable case alias source external-data location: "
                f"{location} aliases {previous_case_location}"
            )
        portable_separator_location = portable_case_location.replace("\\", "/")
        previous_separator_location = portable_separator_seen.get(portable_separator_location)
        if previous_separator_location is not None:
            raise ValueError(
                "portable separator alias source external-data location: "
                f"{location} aliases {previous_separator_location}"
            )

        external_resolved = _safe_relative_path(
            full_model_path.parent,
            location,
            field=f"{field_prefix}.location",
        )
        external_path = (full_model_path.parent / Path(location)).absolute()
        previous_location = seen_paths.get(external_resolved)
        if previous_location is not None:
            if previous_location == "source graph":
                raise ValueError(
                    "source external-data location aliases source graph path: "
                    f"{location}"
                )
            raise ValueError(
                "duplicate source external-data location: "
                f"{location} aliases {previous_location}"
            )
        expected_bytes = _non_negative_int(
            raw_entry.get("bytes"),
            field=f"{field_prefix}.bytes",
        )
        raw_sha = raw_entry.get("sha256")
        if raw_sha is None:
            raise ValueError(
                f"{field_prefix}.sha256 is required for numerical evidence binding"
            )
        expected_sha = _canonical_sha256(raw_sha, field=f"{field_prefix}.sha256")

        seen_locations.add(location)
        portable_case_seen[portable_case_location] = location
        portable_separator_seen[portable_separator_location] = location
        seen_paths[external_resolved] = location
        external_contract.append(
            (location, external_path, external_resolved, expected_bytes, expected_sha)
        )

    return expected_graph_sha, source_graph_path, tuple(external_contract)


def _measure_source_model_identity(
    *,
    report_path: Path,
    graph_path: Path,
    expected_graph_sha: str,
    expected_graph_resolved: Path,
    external_contract: Sequence[SourceExternalContract],
) -> dict[str, object]:
    graph_bytes, observed_graph_sha = _measure_file(
        graph_path,
        missing_message=f"full model not found: {report_path}",
        expected_resolved=expected_graph_resolved,
    )
    if observed_graph_sha != expected_graph_sha:
        raise ValueError(
            "full-model graph SHA-256 mismatch: "
            f"expected={expected_graph_sha}, observed={observed_graph_sha}"
        )

    external_reports: list[dict[str, object]] = []
    for location, external_path, external_resolved, expected_bytes, expected_sha in external_contract:
        observed_bytes, observed_sha = _measure_file(
            external_path,
            missing_message=f"source external data not found: {external_path}",
            expected_resolved=external_resolved,
        )
        if observed_bytes != expected_bytes:
            raise ValueError(
                f"source external-data size mismatch for {location}: "
                f"expected={expected_bytes}, observed={observed_bytes}"
            )
        if observed_sha != expected_sha:
            raise ValueError(
                f"source external-data SHA-256 mismatch for {location}: "
                f"expected={expected_sha}, observed={observed_sha}"
            )
        external_reports.append(
            {
                "location": location,
                "bytes": observed_bytes,
                "sha256": observed_sha,
            }
        )

    return {
        "path": str(report_path),
        "graphBytes": graph_bytes,
        "graphSha256": observed_graph_sha,
        "externalData": external_reports,
        "allExternalDataHashed": True,
    }


def _assert_source_path_identity(
    requested_path: Path,
    resolved_path: Path,
    expected_identity: tuple[int, int],
    *,
    label: str,
) -> None:
    try:
        observed_resolved = requested_path.resolve(strict=True)
        metadata = os.lstat(resolved_path)
    except OSError as error:
        raise RuntimeError(f"{label} changed before reference execution: {requested_path}") from error
    if (
        observed_resolved != resolved_path
        or not stat.S_ISREG(metadata.st_mode)
        or (metadata.st_dev, metadata.st_ino) != expected_identity
    ):
        raise RuntimeError(f"{label} changed before reference execution: {requested_path}")


def _assert_source_link_identity(
    source_path: Path,
    expected_identity: tuple[int, int],
    *,
    label: str,
) -> None:
    try:
        metadata = os.lstat(source_path)
    except OSError as error:
        raise RuntimeError(
            f"{label} changed while execution snapshot was being pinned: {source_path}"
        ) from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or (metadata.st_dev, metadata.st_ino) != expected_identity
    ):
        raise RuntimeError(
            f"{label} changed while execution snapshot was being pinned: {source_path}"
        )


def _link_verified_snapshot_file(
    source_path: Path,
    destination_path: Path,
    expected_identity: tuple[int, int],
    *,
    label: str,
) -> None:
    link_context = _SOURCE_SNAPSHOT_LINK_CONTEXT.get()
    if link_context is None:
        raise AssertionError("source execution snapshot link context is missing")
    snapshot_root, snapshot_root_identity, parent_records = link_context
    try:
        relative = destination_path.relative_to(snapshot_root)
    except ValueError as error:
        raise AssertionError("source execution snapshot destination escapes workspace") from error
    if (
        relative.is_absolute()
        or not relative.parts
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        raise AssertionError("source execution snapshot destination is malformed")

    with prepared_destination(
        snapshot_root,
        tuple(relative.parts),
        snapshot_root_identity,
        label="source execution snapshot",
    ) as (destination, parent_fd, leaf_name, parent_chain):
        parent_records.append(parent_chain)
        _assert_source_link_identity(source_path, expected_identity, label=label)
        try:
            if parent_fd is not None:
                os.link(
                    source_path,
                    leaf_name,
                    dst_dir_fd=parent_fd,
                    follow_symlinks=False,
                )
            else:
                os.link(source_path, destination, follow_symlinks=False)
        except OSError as error:
            raise RuntimeError(
                f"cannot create hard-link execution snapshot for {label}: {source_path}; "
                "source graph and external data must support hard links on the snapshot filesystem; "
                "refusing to duplicate large payload bytes"
            ) from error

        try:
            assert_parent_chain(
                snapshot_root,
                snapshot_root_identity,
                parent_chain,
                label="source execution snapshot",
            )
            if parent_fd is not None:
                metadata = os.stat(
                    leaf_name,
                    dir_fd=parent_fd,
                    follow_symlinks=False,
                )
            else:
                metadata = os.lstat(destination)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or (metadata.st_dev, metadata.st_ino) != expected_identity
            ):
                raise RuntimeError(
                    f"{label} changed while execution snapshot was being pinned: {source_path}"
                )
            assert_parent_chain(
                snapshot_root,
                snapshot_root_identity,
                parent_chain,
                label="source execution snapshot",
            )
        except Exception:
            unlink_pinned_destination(destination, parent_fd, leaf_name)
            raise


def _source_execution_fingerprint(path: Path, *, label: str) -> SourceFingerprint:
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise RuntimeError(f"{label} changed during reference execution: {path}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError(f"{label} changed during reference execution: {path}")
    return (
        metadata.st_mode,
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _capture_source_execution_fingerprints(
    graph_path: Path,
    external_contract: Sequence[SourceExternalContract],
) -> tuple[tuple[str, Path, SourceFingerprint], ...]:
    captured: list[tuple[str, Path, SourceFingerprint]] = [
        (
            "source graph",
            graph_path,
            _source_execution_fingerprint(graph_path, label="source graph"),
        )
    ]
    for location, external_path, _, _, _ in external_contract:
        label = f"source external data {location}"
        captured.append(
            (
                label,
                external_path,
                _source_execution_fingerprint(external_path, label=label),
            )
        )
    return tuple(captured)


def _assert_source_execution_fingerprints(
    captured: Sequence[tuple[str, Path, SourceFingerprint]],
) -> None:
    for label, path, expected in captured:
        observed = _source_execution_fingerprint(path, label=label)
        if observed != expected:
            raise RuntimeError(f"{label} changed during reference execution: {path}")


def _snapshot_workspace_identity(path: Path) -> SnapshotWorkspaceIdentity:
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise RuntimeError(
            f"source execution snapshot workspace changed before cleanup: {path}"
        ) from error
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(
            f"source execution snapshot workspace changed before cleanup: {path}"
        )
    return metadata.st_dev, metadata.st_ino


def _assert_recorded_internal_parents(
    parent_records: Sequence[tuple[InternalParentIdentity, ...]],
    snapshot_root: Path,
    snapshot_root_identity: SnapshotWorkspaceIdentity,
) -> None:
    for parent_chain in parent_records:
        assert_parent_chain(
            snapshot_root,
            snapshot_root_identity,
            parent_chain,
            label="source execution snapshot",
        )


def _remove_verified_snapshot_root(
    snapshot_root: Path,
    expected_identity: SnapshotWorkspaceIdentity,
) -> None:
    observed_identity = _snapshot_workspace_identity(snapshot_root)
    if observed_identity != expected_identity:
        raise RuntimeError(
            f"source execution snapshot workspace changed before cleanup: {snapshot_root}"
        )
    shutil.rmtree(snapshot_root)


@contextmanager
def verified_source_execution_snapshot(
    full_model_path: Path,
    manifest: dict[str, object],
) -> Iterator[tuple[dict[str, object], Path]]:
    """Yield a hard-link-pinned source generation for ORT reference execution."""

    expected_graph_sha, expected_graph_resolved, external_contract = (
        _preflight_source_model_identity(full_model_path, manifest)
    )
    graph_identity, external_identities = _preflight_source_file_identities(
        full_model_path,
        external_contract,
    )
    try:
        snapshot_parent = full_model_path.parent.resolve(strict=True)
        snapshot_root = Path(
            tempfile.mkdtemp(
                prefix=".unzen-source-execution-",
                dir=snapshot_parent,
            )
        ).resolve(strict=True)
        snapshot_root_identity = _snapshot_workspace_identity(snapshot_root)
    except (OSError, RuntimeError) as error:
        raise RuntimeError(
            f"cannot create source execution snapshot beside full model: {full_model_path}"
        ) from error

    parent_records: list[tuple[InternalParentIdentity, ...]] = []
    context_token = _SOURCE_SNAPSHOT_LINK_CONTEXT.set(
        (snapshot_root, snapshot_root_identity, parent_records)
    )
    try:
        snapshot_graph = snapshot_root / full_model_path.name
        _link_verified_snapshot_file(
            expected_graph_resolved,
            snapshot_graph,
            graph_identity,
            label="source graph",
        )
        snapshot_external_contract: list[SourceExternalContract] = []
        for contract_entry, expected_identity in zip(
            external_contract,
            external_identities,
            strict=True,
        ):
            location, _, external_resolved, expected_bytes, expected_sha = contract_entry
            snapshot_external = snapshot_root / Path(location)
            _link_verified_snapshot_file(
                external_resolved,
                snapshot_external,
                expected_identity,
                label=f"source external data {location}",
            )
            snapshot_external_contract.append(
                (
                    location,
                    snapshot_external,
                    snapshot_external.resolve(),
                    expected_bytes,
                    expected_sha,
                )
            )

        _assert_recorded_internal_parents(
            parent_records,
            snapshot_root,
            snapshot_root_identity,
        )
        _assert_source_path_identity(
            full_model_path,
            expected_graph_resolved,
            graph_identity,
            label="source graph",
        )
        for contract_entry, expected_identity in zip(
            external_contract,
            external_identities,
            strict=True,
        ):
            location, external_path, external_resolved, _, _ = contract_entry
            _assert_source_path_identity(
                external_path,
                external_resolved,
                expected_identity,
                label=f"source external data {location}",
            )

        snapshot_fingerprints = _capture_source_execution_fingerprints(
            snapshot_graph,
            tuple(snapshot_external_contract),
        )
        source_identity = _measure_source_model_identity(
            report_path=full_model_path,
            graph_path=snapshot_graph,
            expected_graph_sha=expected_graph_sha,
            expected_graph_resolved=snapshot_graph.resolve(),
            external_contract=tuple(snapshot_external_contract),
        )
        _assert_recorded_internal_parents(
            parent_records,
            snapshot_root,
            snapshot_root_identity,
        )
        _assert_source_execution_fingerprints(snapshot_fingerprints)
        yield source_identity, snapshot_graph
        _assert_recorded_internal_parents(
            parent_records,
            snapshot_root,
            snapshot_root_identity,
        )
        _assert_source_execution_fingerprints(snapshot_fingerprints)
    finally:
        try:
            _assert_recorded_internal_parents(
                parent_records,
                snapshot_root,
                snapshot_root_identity,
            )
            _remove_verified_snapshot_root(snapshot_root, snapshot_root_identity)
        finally:
            _SOURCE_SNAPSHOT_LINK_CONTEXT.reset(context_token)


def verify_source_model_identity(
    full_model_path: Path,
    manifest: dict[str, object],
) -> dict[str, object]:
    """Validate source provenance without creating an execution snapshot."""

    expected_graph_sha, expected_graph_resolved, external_contract = (
        _preflight_source_model_identity(full_model_path, manifest)
    )
    _preflight_source_file_identities(full_model_path, external_contract)
    return _measure_source_model_identity(
        report_path=full_model_path,
        graph_path=full_model_path,
        expected_graph_sha=expected_graph_sha,
        expected_graph_resolved=expected_graph_resolved,
        external_contract=external_contract,
    )
