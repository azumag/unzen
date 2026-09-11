#!/usr/bin/env python3
"""Verify one #167 multi-segment artifact set as a stable filesystem snapshot.

This wraps ``verify_multi_segment_artifacts.py``.  The existing verifier checks
manifest semantics, hashes, bytes, tiers, and browser budgets; this wrapper also
requires the manifest plus every declared graph/external-data path to remain the
same non-symlink regular-file instance before, during, and after that check.
On platforms with ``dir_fd`` + ``O_NOFOLLOW`` support, declared artifact paths
are opened component-by-component from an anchored manifest-directory descriptor
so intermediate directory symlink/replacement races fail closed as well.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import stat
import sys

from verify_multi_segment_artifacts import verify_artifact_integrity

REPORT_KIND = "unzen-budgeted-multi-segment-artifact-snapshot-verification"
REPORT_SCHEMA_VERSION = "1.1.0"
DEFAULT_MANIFEST_MAX_BYTES = 16 * 1024 * 1024
PATH_RESOLUTION_COMPONENT_ANCHORED = "component-anchored-dirfd"
PATH_RESOLUTION_FINAL_ONLY = "final-component-only"


def _identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


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
        raise ValueError(f"split manifest directory is not readable: {root}: {error}") from error
    if stat.S_ISLNK(before.st_mode):
        raise ValueError(f"split manifest directory must not be a symlink: {root}")
    if not stat.S_ISDIR(before.st_mode):
        raise ValueError(f"split manifest directory must be a directory: {root}")
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
    flags |= getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(root, flags)
    except OSError as error:
        raise ValueError(f"split manifest directory could not be opened safely: {root}: {error}") from error
    try:
        opened = os.fstat(fd)
        if not stat.S_ISDIR(opened.st_mode) or _directory_identity(opened) != _directory_identity(before):
            raise ValueError(f"split manifest directory changed between path check and open: {root}")
        return fd, opened
    except Exception:
        os.close(fd)
        raise


def _assert_directory_anchor(root: Path, opened: os.stat_result) -> None:
    try:
        current = os.lstat(root)
    except OSError as error:
        raise ValueError(f"split manifest directory disappeared during verification: {root}: {error}") from error
    if stat.S_ISLNK(current.st_mode) or not stat.S_ISDIR(current.st_mode):
        raise ValueError(f"split manifest directory changed during verification: {root}")
    if _directory_identity(current) != _directory_identity(opened):
        raise ValueError(f"split manifest directory changed during verification: {root}")


def _open_regular(path: Path, *, field: str) -> tuple[int, os.stat_result]:
    path = path.expanduser().absolute()
    try:
        before = os.lstat(path)
    except OSError as error:
        raise ValueError(f"{field} is not readable: {path}: {error}") from error
    if stat.S_ISLNK(before.st_mode):
        raise ValueError(f"{field} must not be a symlink: {path}")
    if not stat.S_ISREG(before.st_mode):
        raise ValueError(f"{field} must be a regular file: {path}")

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except OSError as error:
        raise ValueError(f"{field} could not be opened safely: {path}: {error}") from error
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise ValueError(f"{field} must remain a regular file: {path}")
        if _identity(opened) != _identity(before):
            raise ValueError(f"{field} changed between path check and open: {path}")
        return fd, opened
    except Exception:
        os.close(fd)
        raise


def _open_regular_at(
    root_fd: int,
    parts: tuple[str, ...],
    *,
    path: Path,
    field: str,
) -> tuple[int, os.stat_result, tuple[tuple[str, tuple[int, int]], ...]]:
    if not parts:
        raise ValueError(f"{field} must name a file below the split manifest directory")
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
                if not stat.S_ISDIR(opened_parent.st_mode) or _directory_identity(opened_parent) != _directory_identity(before):
                    raise ValueError(f"{field} parent component changed between path check and open: {'/'.join(prefix)}")
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
            raise ValueError(f"{field} is not readable: {path}: {error}") from error
        if stat.S_ISLNK(before.st_mode):
            raise ValueError(f"{field} must not be a symlink: {path}")
        if not stat.S_ISREG(before.st_mode):
            raise ValueError(f"{field} must be a regular file: {path}")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0)
        try:
            fd = os.open(final, flags, dir_fd=current_fd)
        except OSError as error:
            raise ValueError(f"{field} could not be opened safely: {path}: {error}") from error
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode):
                raise ValueError(f"{field} must remain a regular file: {path}")
            if _identity(opened) != _identity(before):
                raise ValueError(f"{field} changed between path check and open: {path}")
            return fd, opened, tuple(parents)
        except Exception:
            os.close(fd)
            raise
    finally:
        os.close(current_fd)


def _check_anchored_path(
    root_fd: int,
    parts: tuple[str, ...],
    opened: os.stat_result,
    parents: tuple[tuple[str, tuple[int, int]], ...],
    *,
    path: Path,
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
                raise ValueError(f"{field} parent path disappeared after read: {expected_name}: {error}") from error
            if stat.S_ISLNK(current.st_mode) or not stat.S_ISDIR(current.st_mode):
                raise ValueError(f"{field} parent path changed while being read: {expected_name}")
            if _directory_identity(current) != expected_identity:
                raise ValueError(f"{field} parent path changed while being read: {expected_name}")
            try:
                next_fd = os.open(part, directory_flags, dir_fd=current_fd)
            except OSError as error:
                raise ValueError(f"{field} parent path could not be reopened safely: {expected_name}: {error}") from error
            try:
                reopened = os.fstat(next_fd)
                if not stat.S_ISDIR(reopened.st_mode) or _directory_identity(reopened) != expected_identity:
                    raise ValueError(f"{field} parent path changed while being reopened: {expected_name}")
            except Exception:
                os.close(next_fd)
                raise
            os.close(current_fd)
            current_fd = next_fd
        try:
            after_path = os.stat(parts[-1], dir_fd=current_fd, follow_symlinks=False)
        except OSError as error:
            raise ValueError(f"{field} path disappeared after read: {path}: {error}") from error
        if stat.S_ISLNK(after_path.st_mode) or _identity(after_path) != _identity(opened):
            raise ValueError(f"{field} path changed while being read: {path}")
    finally:
        os.close(current_fd)


def _finish_read(
    path: Path,
    fd: int,
    opened: os.stat_result,
    observed: int,
    *,
    field: str,
    root_fd: int | None = None,
    parts: tuple[str, ...] | None = None,
    parents: tuple[tuple[str, tuple[int, int]], ...] = (),
) -> tuple[int, int, int, int, int]:
    path = path.expanduser().absolute()
    after_fd = os.fstat(fd)
    if _identity(after_fd) != _identity(opened) or observed != after_fd.st_size:
        raise ValueError(f"{field} changed while being read: {path}")
    if root_fd is not None and parts is not None:
        _check_anchored_path(root_fd, parts, opened, parents, path=path, field=field)
    else:
        try:
            after_path = os.lstat(path)
        except OSError as error:
            raise ValueError(f"{field} path disappeared after read: {path}: {error}") from error
        if stat.S_ISLNK(after_path.st_mode) or _identity(after_path) != _identity(opened):
            raise ValueError(f"{field} path changed while being read: {path}")
    return _identity(after_fd)


def _read_manifest(
    path: Path,
    *,
    root_fd: int | None = None,
) -> tuple[bytes, tuple[int, int, int, int, int]]:
    if root_fd is None:
        fd, opened = _open_regular(path, field="split manifest")
        parents: tuple[tuple[str, tuple[int, int]], ...] = ()
        parts = None
    else:
        parts = (path.name,)
        fd, opened, parents = _open_regular_at(root_fd, parts, path=path, field="split manifest")
    try:
        if opened.st_size > DEFAULT_MANIFEST_MAX_BYTES:
            raise ValueError(f"split manifest exceeds {DEFAULT_MANIFEST_MAX_BYTES} bytes: {path}")
        chunks: list[bytes] = []
        observed = 0
        while True:
            chunk = os.read(fd, min(1024 * 1024, DEFAULT_MANIFEST_MAX_BYTES + 1 - observed))
            if not chunk:
                break
            chunks.append(chunk)
            observed += len(chunk)
            if observed > DEFAULT_MANIFEST_MAX_BYTES:
                raise ValueError("split manifest grew beyond the input limit")
        return b"".join(chunks), _finish_read(
            path,
            fd,
            opened,
            observed,
            field="split manifest",
            root_fd=root_fd,
            parts=parts,
            parents=parents,
        )
    finally:
        os.close(fd)


def _measure(
    path: Path,
    *,
    field: str,
    root_fd: int | None = None,
    parts: tuple[str, ...] | None = None,
) -> dict[str, object]:
    if root_fd is None or parts is None:
        fd, opened = _open_regular(path, field=field)
        parents: tuple[tuple[str, tuple[int, int]], ...] = ()
    else:
        fd, opened, parents = _open_regular_at(root_fd, parts, path=path, field=field)
    digest = hashlib.sha256()
    observed = 0
    try:
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            observed += len(chunk)
        identity = _finish_read(
            path,
            fd,
            opened,
            observed,
            field=field,
            root_fd=root_fd,
            parts=parts,
            parents=parents,
        )
        return {
            "bytes": observed,
            "sha256": digest.hexdigest(),
            "identity": identity,
            "parentIdentities": parents,
        }
    finally:
        os.close(fd)


def _text(raw: object, *, field: str) -> str:
    if not isinstance(raw, str) or not raw:
        raise ValueError(f"{field} must be a non-empty string")
    return raw


def _index(raw: object, *, field: str) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return raw


def _safe_path(root: Path, raw: object, *, field: str) -> tuple[str, Path, tuple[str, ...]]:
    value = _text(raw, field=field)
    posix, windows = PurePosixPath(value), PureWindowsPath(value)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or bool(windows.drive)
        or bool(windows.root)
        or any(":" in part for part in windows.parts)
        or ".." in posix.parts
        or ".." in windows.parts
    ):
        raise ValueError(f"unsafe {field}: {value}")
    parts = tuple(Path(value).parts)
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"unsafe {field}: {value}")
    root = root.resolve()
    candidate = (root / Path(value)).absolute()
    parent = candidate.parent.resolve()
    if parent != root and root not in parent.parents:
        raise ValueError(f"{field} escapes split manifest directory: {value}")
    return value, candidate, parts


def _declared_files(manifest: dict[str, object], root: Path) -> list[dict[str, object]]:
    segments = manifest.get("segments")
    if not isinstance(segments, list) or not segments:
        raise ValueError("split manifest must contain at least one segment")
    result: list[dict[str, object]] = []
    seen: set[Path] = set()
    for expected, raw_segment in enumerate(segments):
        if not isinstance(raw_segment, dict):
            raise ValueError(f"segments[{expected}] must be an object")
        index = _index(raw_segment.get("index"), field=f"segments[{expected}].index")
        if index != expected:
            raise ValueError(f"segments[{expected}].index must equal {expected}")
        pairs = [(f"segments[{index}].path", raw_segment.get("path"))]
        external = raw_segment.get("externalData")
        if not isinstance(external, list):
            raise ValueError(f"segments[{index}].externalData must be an array")
        for n, entry in enumerate(external):
            if not isinstance(entry, dict):
                raise ValueError(f"segments[{index}].externalData[{n}] must be an object")
            pairs.append((f"segments[{index}].externalData[{n}].location", entry.get("location")))
        for field, raw_path in pairs:
            name, path, parts = _safe_path(root, raw_path, field=field)
            if path in seen:
                raise ValueError(f"duplicate declared artifact path: {name}")
            seen.add(path)
            result.append({"field": field, "path": name, "absolute": path, "parts": parts})
    return result


def _measure_all(entries: list[dict[str, object]], *, root_fd: int | None) -> list[dict[str, object]]:
    measured: list[dict[str, object]] = []
    for entry in entries:
        path = entry["absolute"]
        parts = entry["parts"]
        if not isinstance(path, Path):
            raise AssertionError("internal artifact path must be a Path")
        if not isinstance(parts, tuple) or not all(isinstance(part, str) for part in parts):
            raise AssertionError("internal artifact path parts must be strings")
        measured.append({**entry, **_measure(path, field=str(entry["field"]), root_fd=root_fd, parts=parts)})
    return measured


def verify_artifact_snapshot(manifest_path: Path) -> dict[str, object]:
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
        before = _measure_all(declared, root_fd=root_fd)

        integrity_manifest = root / manifest_path.name if root_fd is not None else manifest_path
        integrity = verify_artifact_integrity(integrity_manifest)
        if integrity.get("status") != "pass":
            raise RuntimeError("underlying artifact integrity verification did not pass")
        if integrity.get("manifestSha256") != manifest_sha:
            raise ValueError("underlying verifier observed a different manifest snapshot")
        if root_opened is not None:
            _assert_directory_anchor(root, root_opened)

        after_bytes, after_identity = _read_manifest(manifest_path, root_fd=root_fd)
        if after_identity != manifest_identity or hashlib.sha256(after_bytes).hexdigest() != manifest_sha:
            raise ValueError("split manifest changed across artifact integrity verification")

        after = _measure_all(declared, root_fd=root_fd)
        for old, new in zip(before, after, strict=True):
            if old["parentIdentities"] != new["parentIdentities"]:
                raise ValueError(
                    "declared artifact parent directory changed across artifact integrity verification: "
                    f"{old['field']} ({old['path']})"
                )
            if old["identity"] != new["identity"] or old["bytes"] != new["bytes"] or old["sha256"] != new["sha256"]:
                raise ValueError(
                    "declared artifact changed across artifact integrity verification: "
                    f"{old['field']} ({old['path']})"
                )
        if root_opened is not None:
            _assert_directory_anchor(root, root_opened)

        public = [
            {"field": item["field"], "path": item["path"], "bytes": item["bytes"], "sha256": item["sha256"]}
            for item in before
        ]
        return {
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
    finally:
        if root_fd is not None:
            os.close(root_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = verify_artifact_snapshot(args.manifest)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())