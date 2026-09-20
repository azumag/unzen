#!/usr/bin/env python3
"""Report whether this host can satisfy execution-snapshot filesystem contracts.

This preflight is intentionally dependency-neutral so operators can reject an
unsupported evidence host before model downloads or ONNX Runtime/WebGPU work.
The platform rules remain owned by ``execution_snapshot_internal_paths``; this
module only presents those existing predicates as a stable machine-readable
report and CLI gate.
"""

from __future__ import annotations

import argparse
import json
from typing import Sequence

from execution_snapshot_internal_paths import (
    component_walk_supported,
    nofollow_hardlink_supported,
    nofollow_stat_supported,
)


SCHEMA_VERSION = "1.0.0"
MODE_COMPONENT_ANCHORED = "component-anchored"
MODE_PATHNAME_FALLBACK = "pathname-fallback"
MODE_UNSUPPORTED = "unsupported"
REQUIREMENTS = ("all", "generated", "source", "legacy")


def _mode(*, anchored: bool, fallback: bool) -> str:
    if anchored:
        return MODE_COMPONENT_ANCHORED
    if fallback:
        return MODE_PATHNAME_FALLBACK
    return MODE_UNSUPPORTED


def capability_report() -> dict[str, object]:
    """Return one snapshot of the execution-snapshot filesystem capabilities."""

    anchored = component_walk_supported()
    nofollow_link = nofollow_hardlink_supported()
    nofollow_stat = nofollow_stat_supported()

    pathname_fallback = nofollow_link

    source_mode = _mode(anchored=anchored, fallback=pathname_fallback)
    legacy_mode = _mode(anchored=anchored, fallback=pathname_fallback)
    generated_mode = _mode(anchored=anchored, fallback=pathname_fallback)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "capabilities": {
            "componentAnchored": anchored,
            "nofollowHardlink": nofollow_link,
            "nofollowStat": nofollow_stat,
        },
        "snapshotPaths": {
            "sourceModel": {
                "usable": source_mode != MODE_UNSUPPORTED,
                "mode": source_mode,
            },
            "legacyTwoSegment": {
                "usable": legacy_mode != MODE_UNSUPPORTED,
                "mode": legacy_mode,
            },
            "generatedMultiSegment": {
                "usable": generated_mode != MODE_UNSUPPORTED,
                "mode": generated_mode,
            },
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
