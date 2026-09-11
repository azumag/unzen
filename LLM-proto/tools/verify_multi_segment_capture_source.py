#!/usr/bin/env python3
"""Verify the original full-model identity behind a published #167 capture.

``verify_multi_segment_capture_bundle.py`` proves that the files inside a capture
bundle still agree with one another. The original full ONNX graph and its
external-data files intentionally stay outside that bundle, though, so they need
an independent audit if an operator wants to prove that the published numerical
evidence still names the exact source artifacts on disk.

This verifier is stdlib-only. It first reuses the published-bundle verifier, then
binds the same bundle snapshot to the caller-supplied full model and every source
external-data file recorded in the split manifest. ONNX Runtime is never loaded.
The run summary, split manifest, and numerical evidence are reparsed from bounded
stable regular-file snapshots whose exact read digests are bound to the bundle
report. Source artifacts are hashed through already-open file descriptors and are
required to remain the same non-symlink regular files for the entire read. On
platforms with dir_fd + O_NOFOLLOW support, the source root is anchored once and
all graph/external-data path components are opened relative to that descriptor.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat

from verify_multi_segment_artifacts import sha256_file
from verify_multi_segment_capture_bundle import verify_capture_bundle
from verify_multi_segment_capture_source_provenance import (
    _capture_path,
    _stable_json_object,
)


REPORT_KIND = "unzen-budgeted-multi-segment-capture-source-verification"
REPORT_SCHEMA_VERSION = "1.0.0"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
PATH_RESOLUTION_COMPONENT_ANCHORED = "component-anchored-dirfd"
PATH_RESOLUTION_FINAL_ONLY = "final-component-only"


def _json_object(path: Path, *, field: str) -> dict[str, object]:
    if not path.is_file():
        raise FileNotFoundError(f"{field} not found: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{field} is not valid UTF-8 JSON: {path}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{field} must contain a JSON object")
    return value


def _require_mapping(raw: object, *, field: str) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise ValueError(f"{field} must be an object")
    return raw


def _non_empty_string(raw: object, *, field: str) -> str:
    if not isinstance(raw, str) or not raw:
        raise ValueError(f"{field} must be a non-empty string")
    return raw


def _canonical_sha256(raw: object, *, field: str) -> str:
    value = _non_empty_string(raw, field=field)
    if not SHA256_RE.fullmatch(value):
        raise ValueError(f"{field} must be a canonical lowercase SHA-256 digest")
    return value


def _non_negative_int(raw: object, *, field: str) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return raw


def _relative_path_text(raw: object, *, field: str) -> str:
    value = _non_empty_string(raw, field=field)
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or bool(windows.drive)
        or ".." in posix.parts
        or ".." in windows.parts
    ):
        raise ValueError(f"unsafe {field}: {value}")
    return value


def _safe_relative_path(root: Path, raw: object, *, field: str) -> Path:
    """Resolve an ordinary bundle-relative path and reject escapes."""

    value = _relative_path_text(raw, field=field)
    resolved_root = root.resolve()
    resolved = (root / Path(value)).resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise ValueError(f"{field} escapes its root: {value}")
    return resolved


def _safe_source_relative_path(root: Path, raw: object, *, field: str) -> Path:
    """Validate a source path without dereferencing its final component."""

    value = _relative_path_text(raw, field=field)
    absolute_root = root.expanduser().absolute()
    candidate = (absolute_root / Path(value)).absolute()
    resolved_root = absolute_root.resolve()
    resolved_parent = candidate.parent.resolve()
    if resolved_parent != resolved_root and resolved_root not in resolved_parent.parents:
        raise ValueError(f"{field} escapes its root: {value}")
    return candidate


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _directory_identity(value: os.stat_result) -> tuple[int, int]:
    return (value.st_dev, value.st_ino)


def _component_walk_supported() -> bool:
    return (
        os.open in getattr(os, "supports_dir_fd", set())
        and os.stat in getattr(os, "supports_dir_fd", set())
        and os.stat in getattr(os, "supports_follow_symlinks", set())
        and hasattr(os, "O_DIRECTORY")
        and hasattr(os, "O_NOFOLLOW")
    )


def _open_directory_anchor(root: Path) -> tuple[int, os.stat_result]:
    root = root.expanduser().absolute()
    try:
        before = os.lstat(root)
    except OSError as error:
        raise ValueError(f"source model directory is not readable: {root}: {error}") from error
    if stat.S_ISLNK(before.st_mode):
        raise ValueError(f"source model directory must not be a symlink: {root}")
    if not stat.S_ISDIR(before.st_mode):
        raise ValueError(f"source model directory must be a directory: {root}")
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
    flags |= getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(root, flags)
    except OSError as error:
        raise ValueError(f"source model directory could not be opened safely: {root}: {error}") from error
    try:
        opened = os.fstat(fd)
        if not stat.S_ISDIR(opened.st_mode) or _directory_identity(opened) != _directory_identity(before):
            raise RuntimeError(f"source model directory changed between path check and open: {root}")
        return fd, opened
    except Exception:
        os.close(fd)
        raise


def _assert_directory_anchor(root: Path, opened: os.stat_result) -> None:
    try:
        current = os.lstat(root)
    except OSError as error:
        raise RuntimeError(f"source model directory disappeared during verification: {root}") from error
    if (
        stat.S_ISLNK(current.st_mode)
        or not stat.S_ISDIR(current.st_mode)
        or _directory_identity(current) != _directory_identity(opened)
    ):
        raise RuntimeError(f"source model directory changed during verification: {root}")


def _sha256_fd(fd: int) -> str:
    """Hash the bytes of one already-open regular-file descriptor."""

    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    return digest.hexdigest()


def _stable_identity(path: Path, *, field: str) -> tuple[int, str]:
    """Portable final-component check used when component walking is unavailable."""

    source = path.expanduser().absolute()
    try:
        before = os.lstat(source)
    except OSError as error:
        raise FileNotFoundError(f"{field} not found: {source}") from error
    if stat.S_ISLNK(before.st_mode):
        raise ValueError(f"{field} must not be a symlink: {source}")
    if not stat.S_ISREG(before.st_mode):
        raise ValueError(f"{field} must be a regular file: {source}")

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(source, flags)
    except OSError as error:
        raise ValueError(f"{field} could not be opened safely: {source}: {error}") from error

    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise ValueError(f"{field} must remain a regular file: {source}")
        if _stat_identity(opened) != _stat_identity(before):
            raise RuntimeError(f"{field} changed between path check and open: {source}")
        digest = _sha256_fd(fd)
        after_fd = os.fstat(fd)
        if _stat_identity(after_fd) != _stat_identity(opened):
            raise RuntimeError(f"{field} changed while it was being hashed: {source}")
    finally:
        os.close(fd)

    try:
        after_path = os.lstat(source)
    except OSError as error:
        raise RuntimeError(f"{field} path disappeared while it was being hashed: {source}") from error
    if stat.S_ISLNK(after_path.st_mode) or _stat_identity(after_path) != _stat_identity(opened):
        raise RuntimeError(f"{field} path changed while it was being hashed: {source}")
    return after_path.st_size, digest


def _relative_parts(raw: object, *, field: str) -> tuple[str, Path, tuple[str, ...]]:
    value = _relative_path_text(raw, field=field)
    parts = tuple(Path(value).parts)
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"unsafe {field}: {value}")
    return value, Path(value), parts


def _check_anchored_path(
    root_fd: int,
    parts: tuple[str, ...],
    opened: os.stat_result,
    parents: tuple[tuple[str, tuple[int, int]], ...],
    *,
    field: str,
) -> None:
    current_fd = os.dup(root_fd)
    try:
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
        directory_flags |= getattr(os, "O_NONBLOCK", 0)
        for index, part in enumerate(parts[:-1]):
            expected_name, expected_identity = parents[index]
            try:
                current = os.stat(part, dir_fd=current_fd, follow_symlinks=False)
            except OSError as error:
                raise RuntimeError(f"{field} parent path disappeared after read: {expected_name}") from error
            if (
                stat.S_ISLNK(current.st_mode)
                or not stat.S_ISDIR(current.st_mode)
                or _directory_identity(current) != expected_identity
            ):
                raise RuntimeError(f"{field} parent path changed while being hashed: {expected_name}")
            try:
                next_fd = os.open(part, directory_flags, dir_fd=current_fd)
            except OSError as error:
                raise RuntimeError(f"{field} parent path could not be reopened safely: {expected_name}") from error
            try:
                reopened = os.fstat(next_fd)
                if (
                    not stat.S_ISDIR(reopened.st_mode)
                    or _directory_identity(reopened) != expected_identity
                ):
                    raise RuntimeError(f"{field} parent path changed while being reopened: {expected_name}")
            except Exception:
                os.close(next_fd)
                raise
            os.close(current_fd)
            current_fd = next_fd
        try:
            after_path = os.stat(parts[-1], dir_fd=current_fd, follow_symlinks=False)
        except OSError as error:
            raise RuntimeError(f"{field} path disappeared while it was being hashed") from error
        if stat.S_ISLNK(after_path.st_mode) or _stat_identity(after_path) != _stat_identity(opened):
            raise RuntimeError(f"{field} path changed while it was being hashed")
    finally:
        os.close(current_fd)


def _stable_identity_at(
    root_fd: int,
    parts: tuple[str, ...],
    *,
    field: str,
) -> tuple[int, str]:
    """Hash a source file via an anchored dirfd and reject parent-path races."""

    if not parts:
        raise ValueError(f"{field} must name a file below the source model directory")
    current_fd = os.dup(root_fd)
    parents: list[tuple[str, tuple[int, int]]] = []
    prefix: list[str] = []
    try:
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
        directory_flags |= getattr(os, "O_NONBLOCK", 0)
        for part in parts[:-1]:
            prefix.append(part)
            try:
                before = os.stat(part, dir_fd=current_fd, follow_symlinks=False)
            except OSError as error:
                raise ValueError(f"{field} parent component is not readable: {'/'.join(prefix)}: {error}") from error
            if stat.S_ISLNK(before.st_mode):
                raise ValueError(f"{field} parent component must not be a symlink: {'/'.join(prefix)}")
            if not stat.S_ISDIR(before.st_mode):
                raise ValueError(f"{field} parent component must be a directory: {'/'.join(prefix)}")
            try:
                next_fd = os.open(part, directory_flags, dir_fd=current_fd)
            except OSError as error:
                raise ValueError(f"{field} parent component could not be opened safely: {'/'.join(prefix)}: {error}") from error
            try:
                opened_parent = os.fstat(next_fd)
                if (
                    not stat.S_ISDIR(opened_parent.st_mode)
                    or _directory_identity(opened_parent) != _directory_identity(before)
                ):
                    raise RuntimeError(f"{field} parent component changed between path check and open: {'/'.join(prefix)}")
            except Exception:
                os.close(next_fd)
                raise
            os.close(current_fd)
            current_fd = next_fd
            parents.append(("/".join(prefix), _directory_identity(opened_parent)))

        final = parts[-1]
        try:
            before = os.stat(final, dir_fd=current_fd, follow_symlinks=False)
        except OSError as error:
            raise FileNotFoundError(f"{field} not found: {'/'.join(parts)}") from error
        if stat.S_ISLNK(before.st_mode):
            raise ValueError(f"{field} must not be a symlink: {'/'.join(parts)}")
        if not stat.S_ISREG(before.st_mode):
            raise ValueError(f"{field} must be a regular file: {'/'.join(parts)}")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
        flags |= getattr(os, "O_NONBLOCK", 0)
        try:
            fd = os.open(final, flags, dir_fd=current_fd)
        except OSError as error:
            raise ValueError(f"{field} could not be opened safely: {'/'.join(parts)}: {error}") from error
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode):
                raise ValueError(f"{field} must remain a regular file: {'/'.join(parts)}")
            if _stat_identity(opened) != _stat_identity(before):
                raise RuntimeError(f"{field} changed between path check and open: {'/'.join(parts)}")
            digest = _sha256_fd(fd)
            after_fd = os.fstat(fd)
            if _stat_identity(after_fd) != _stat_identity(opened):
                raise RuntimeError(f"{field} changed while it was being hashed: {'/'.join(parts)}")
            _check_anchored_path(root_fd, parts, opened, tuple(parents), field=field)
            return after_fd.st_size, digest
        finally:
            os.close(fd)
    finally:
        os.close(current_fd)


def _normalized_external_entries(raw: object, *, field: str) -> list[dict[str, object]]:
    if not isinstance(raw, list):
        raise ValueError(f"{field} must be an array")
    normalized: list[dict[str, object]] = []
    seen: set[str] = set()
    for index, raw_entry in enumerate(raw):
        prefix = f"{field}[{index}]"
        entry = _require_mapping(raw_entry, field=prefix)
        location = _non_empty_string(entry.get("location"), field=f"{prefix}.location")
        posix = PurePosixPath(location)
        windows = PureWindowsPath(location)
        if (
            posix.is_absolute()
            or windows.is_absolute()
            or bool(windows.drive)
            or ".." in posix.parts
            or ".." in windows.parts
        ):
            raise ValueError(f"unsafe {prefix}.location: {location}")
        if location in seen:
            raise ValueError(f"duplicate external-data location in {field}: {location}")
        seen.add(location)
        normalized.append(
            {
                "location": location,
                "bytes": _non_negative_int(entry.get("bytes"), field=f"{prefix}.bytes"),
                "sha256": _canonical_sha256(entry.get("sha256"), field=f"{prefix}.sha256"),
            }
        )
    return sorted(normalized, key=lambda item: str(item["location"]))


def _require_equal(left: object, right: object, *, field: str) -> None:
    if left != right:
        raise ValueError(f"{field} mismatch: expected={left!r}, observed={right!r}")


def verify_capture_source(capture_dir: Path, full_model_path: Path) -> dict[str, object]:
    """Bind a valid published capture bundle to its original source artifacts."""

    root = capture_dir.expanduser().absolute()
    full_model = full_model_path.expanduser().absolute()
    bundle = verify_capture_bundle(root)
    if bundle.get("status") != "pass":
        raise RuntimeError("published capture bundle verification did not pass")

    bundle_run_summary_sha = _canonical_sha256(bundle.get("runSummarySha256"), field="bundle.runSummarySha256")
    bundle_manifest_sha = _canonical_sha256(bundle.get("manifestSha256"), field="bundle.manifestSha256")
    bundle_evidence_sha = _canonical_sha256(bundle.get("evidenceSha256"), field="bundle.evidenceSha256")
    bundle_verification_sha = _canonical_sha256(bundle.get("verificationSha256"), field="bundle.verificationSha256")

    summary_path = root / "run-summary.json"
    summary, summary_sha = _stable_json_object(summary_path, field="run summary")
    summary_artifacts = _require_mapping(summary.get("artifacts"), field="run-summary.artifacts")
    manifest_path = _capture_path(root, summary_artifacts.get("manifest"), field="run-summary.artifacts.manifest")
    summary_evidence = _require_mapping(summary.get("evidence"), field="run-summary.evidence")
    evidence_path = _capture_path(root, summary_evidence.get("path"), field="run-summary.evidence.path")

    _require_equal(bundle_run_summary_sha, summary_sha, field="bundle run-summary snapshot")
    manifest, manifest_sha = _stable_json_object(manifest_path, field="split manifest")
    _require_equal(bundle_manifest_sha, manifest_sha, field="bundle manifest snapshot")

    manifest_source = _require_mapping(manifest.get("sourceModel"), field="split-manifest.sourceModel")
    expected_graph_sha = _canonical_sha256(manifest_source.get("sha256"), field="split-manifest.sourceModel.sha256")
    manifest_external = _normalized_external_entries(
        manifest_source.get("externalData"), field="split-manifest.sourceModel.externalData"
    )

    source_mode = PATH_RESOLUTION_FINAL_ONLY
    source_root = full_model.parent
    source_root_fd: int | None = None
    source_root_stat: os.stat_result | None = None
    if _component_walk_supported():
        source_root = source_root.resolve()
        source_root_fd, source_root_stat = _open_directory_anchor(source_root)
        source_mode = PATH_RESOLUTION_COMPONENT_ANCHORED

    try:
        if source_root_fd is not None:
            graph_bytes, observed_graph_sha = _stable_identity_at(
                source_root_fd, (full_model.name,), field="full model graph"
            )
        else:
            graph_bytes, observed_graph_sha = _stable_identity(full_model, field="full model graph")
        _require_equal(expected_graph_sha, observed_graph_sha, field="source graph SHA-256")
        _require_equal(
            expected_graph_sha,
            _canonical_sha256(bundle.get("sourceGraphSha256"), field="bundle.sourceGraphSha256"),
            field="split manifest source graph vs capture bundle",
        )

        observed_external: list[dict[str, object]] = []
        for index, entry in enumerate(manifest_external):
            location = str(entry["location"])
            field = f"source external data {location}"
            if source_root_fd is not None:
                _value, _relative, parts = _relative_parts(
                    location,
                    field=f"split-manifest.sourceModel.externalData[{index}].location",
                )
                observed_bytes, observed_sha = _stable_identity_at(
                    source_root_fd, parts, field=field
                )
            else:
                source_path = _safe_source_relative_path(
                    full_model.parent,
                    location,
                    field=f"split-manifest.sourceModel.externalData[{index}].location",
                )
                observed_bytes, observed_sha = _stable_identity(source_path, field=field)
            _require_equal(entry["bytes"], observed_bytes, field=f"source external-data bytes for {location}")
            _require_equal(entry["sha256"], observed_sha, field=f"source external-data SHA-256 for {location}")
            observed_external.append(
                {"location": location, "bytes": observed_bytes, "sha256": observed_sha}
            )

        if source_root_fd is not None and source_root_stat is not None:
            _assert_directory_anchor(source_root, source_root_stat)
    finally:
        if source_root_fd is not None:
            os.close(source_root_fd)

    evidence, evidence_sha = _stable_json_object(evidence_path, field="same-machine evidence")
    _require_equal(bundle_evidence_sha, evidence_sha, field="bundle evidence snapshot")
    verification = _require_mapping(evidence.get("verification"), field="evidence.verification")
    verification_source = _require_mapping(
        verification.get("sourceModel"), field="evidence.verification.sourceModel"
    )
    if verification_source.get("allExternalDataHashed") is not True:
        raise ValueError("evidence.verification.sourceModel must hash all external data")
    _require_equal(
        expected_graph_sha,
        _canonical_sha256(
            verification_source.get("graphSha256"), field="evidence.verification.sourceModel.graphSha256"
        ),
        field="split manifest source graph vs embedded verification",
    )
    if "graphBytes" in verification_source:
        _require_equal(
            graph_bytes,
            _non_negative_int(
                verification_source.get("graphBytes"), field="evidence.verification.sourceModel.graphBytes"
            ),
            field="source graph bytes vs embedded verification",
        )
    verification_external = _normalized_external_entries(
        verification_source.get("externalData"), field="evidence.verification.sourceModel.externalData"
    )
    _require_equal(
        manifest_external,
        verification_external,
        field="split manifest source external data vs embedded verification",
    )

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "captureStatus": bundle.get("captureStatus"),
        "runSummarySha256": bundle_run_summary_sha,
        "manifestSha256": bundle_manifest_sha,
        "evidenceSha256": bundle_evidence_sha,
        "verificationSha256": bundle_verification_sha,
        "sourcePathResolutionMode": source_mode,
        "sourceGraphBytes": graph_bytes,
        "sourceGraphSha256": observed_graph_sha,
        "sourceExternalDataCount": len(observed_external),
        "sourceExternalDataBytes": sum(int(item["bytes"]) for item in observed_external),
        "sourceExternalData": observed_external,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-dir", type=Path, required=True)
    parser.add_argument("--full-model", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = verify_capture_source(args.capture_dir, args.full_model)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
