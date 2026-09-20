#!/usr/bin/env python3
"""Report whether this host can satisfy execution-snapshot filesystem contracts.

This preflight is intentionally dependency-neutral so operators can reject an
unsupported evidence host before model downloads or ONNX Runtime/WebGPU work.
The platform rules remain owned by ``execution_snapshot_internal_paths`` plus
the generated-only manifest-write capability boundary; this module presents
those predicates as a stable machine-readable report and CLI gate.
"""

from __future__ import annotations

import argparse
import json
from typing import Sequence

from execution_snapshot_internal_paths import (
    MODE_COMPONENT_ANCHORED,
    MODE_PATHNAME_FALLBACK,
    MODE_UNSUPPORTED,
    component_walk_supported,
    execution_snapshot_mode,
    generation_bound_cleanup_supported,
    lstat_supported,
    nofollow_hardlink_supported,
    nofollow_stat_supported,
)
from execution_snapshot_manifest_write import manifest_write_supported


SCHEMA_VERSION = "1.4.0"
REQUIREMENTS = ("all", "generated", "source", "legacy")


def _missing_capabilities(
    *,
    component_anchored: bool,
    nofollow_link: bool,
    pathname_lstat: bool,
    generation_bound_cleanup: bool,
) -> list[str]:
    """Return capabilities that prevent every safe shared path-pinning mode."""

    missing: list[str] = []
    if not pathname_lstat:
        missing.append("pathnameLstat")
    if not component_anchored and not nofollow_link:
        missing.append("nofollowHardlink")
    if not generation_bound_cleanup:
        missing.append("generationBoundCleanup")
    return missing


def capability_report() -> dict[str, object]:
    """Return one snapshot of the execution-snapshot filesystem capabilities."""

    component_anchored = component_walk_supported()
    nofollow_link = nofollow_hardlink_supported()
    nofollow_stat = nofollow_stat_supported()
    pathname_lstat = lstat_supported()
    generation_bound_cleanup = generation_bound_cleanup_supported()
    snapshot_manifest_write = manifest_write_supported()

    mode = execution_snapshot_mode(
        component_anchored=component_anchored,
        nofollow_hardlink=nofollow_link,
        pathname_lstat=pathname_lstat,
    )
    missing_capabilities = _missing_capabilities(
        component_anchored=component_anchored,
        nofollow_link=nofollow_link,
        pathname_lstat=pathname_lstat,
        generation_bound_cleanup=generation_bound_cleanup,
    )

    def snapshot_path(*, require_manifest_write: bool = False) -> dict[str, object]:
        missing = list(missing_capabilities)
        if require_manifest_write and not snapshot_manifest_write:
            missing.append("snapshotManifestWrite")
        usable = mode != MODE_UNSUPPORTED and not missing
        return {
            "usable": usable,
            "mode": mode if usable else MODE_UNSUPPORTED,
            "missingCapabilities": missing,
        }

    return {
        "schemaVersion": SCHEMA_VERSION,
        "capabilities": {
            "componentAnchored": component_anchored,
            "nofollowHardlink": nofollow_link,
            "nofollowStat": nofollow_stat,
            "pathnameLstat": pathname_lstat,
            "generationBoundCleanup": generation_bound_cleanup,
            "snapshotManifestWrite": snapshot_manifest_write,
        },
        "snapshotPaths": {
            "sourceModel": snapshot_path(),
            "legacyTwoSegment": snapshot_path(),
            "generatedMultiSegment": snapshot_path(require_manifest_write=True),
        },
    }


def requirement_satisfied(report: dict[str, object], requirement: str) -> bool:
    if requirement not in REQUIREMENTS:
        raise ValueError(f"unknown execution-snapshot requirement: {requirement}")

    raw_paths = report.get("snapshotPaths")
    if not isinstance(raw_paths, dict):
        raise ValueError("execution-snapshot capability report is malformed")

    def usable(name: str) -> bool:
        raw = raw_paths.get(name)
        if not isinstance(raw, dict) or not isinstance(raw.get("usable"), bool):
            raise ValueError("execution-snapshot capability report is malformed")
        return bool(raw["usable"])

    if requirement == "generated":
        return usable("generatedMultiSegment")
    if requirement == "source":
        return usable("sourceModel")
    if requirement == "legacy":
        return usable("legacyTwoSegment")
    return (
        usable("sourceModel")
        and usable("legacyTwoSegment")
        and usable("generatedMultiSegment")
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Report execution-snapshot filesystem capabilities before expensive "
            "real-model evidence work."
        )
    )
    parser.add_argument(
        "--require",
        choices=REQUIREMENTS,
        default="all",
        help="exit non-zero unless the selected snapshot path is usable (default: all)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="pretty-print the JSON report",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    report = capability_report()
    print(
        json.dumps(
            report,
            indent=2 if args.pretty else None,
            sort_keys=True,
            separators=None if args.pretty else (",", ":"),
        )
    )
    return 0 if requirement_satisfied(report, args.require) else 1


if __name__ == "__main__":
    raise SystemExit(main())
