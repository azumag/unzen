from __future__ import annotations

from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import check_execution_snapshot_capabilities as preflight  # noqa: E402


class ExecutionSnapshotCapabilityPreflightTest(unittest.TestCase):
    def _report(
        self,
        *,
        anchored: bool,
        nofollow_link: bool,
        nofollow_stat: bool,
    ) -> dict[str, object]:
        with (
            mock.patch.object(
                preflight,
                "component_walk_supported",
                return_value=anchored,
            ),
            mock.patch.object(
                preflight,
                "nofollow_hardlink_supported",
                return_value=nofollow_link,
            ),
            mock.patch.object(
                preflight,
                "nofollow_stat_supported",
                return_value=nofollow_stat,
            ),
        ):
            return preflight.capability_report()

    def test_fully_anchored_host_reports_all_paths_usable(self) -> None:
        report = self._report(
            anchored=True,
            nofollow_link=True,
            nofollow_stat=True,
        )
        self.assertEqual(report["schemaVersion"], preflight.SCHEMA_VERSION)
        self.assertEqual(
            report["capabilities"],
            {
                "componentAnchored": True,
                "nofollowHardlink": True,
                "nofollowStat": True,
            },
        )
        paths = report["snapshotPaths"]
        self.assertIsInstance(paths, dict)
        for name in ("sourceModel", "legacyTwoSegment", "generatedMultiSegment"):
            self.assertEqual(
                paths[name],
                {"usable": True, "mode": preflight.MODE_COMPONENT_ANCHORED},
            )
        self.assertTrue(preflight.requirement_satisfied(report, "all"))

    def test_all_paths_can_use_link_only_pathname_fallback(self) -> None:
        report = self._report(
            anchored=False,
            nofollow_link=True,
            nofollow_stat=False,
        )
        paths = report["snapshotPaths"]
        for name in ("sourceModel", "legacyTwoSegment", "generatedMultiSegment"):
            self.assertEqual(
                paths[name],
                {"usable": True, "mode": preflight.MODE_PATHNAME_FALLBACK},
            )
        self.assertTrue(preflight.requirement_satisfied(report, "generated"))
        self.assertTrue(preflight.requirement_satisfied(report, "source"))
        self.assertTrue(preflight.requirement_satisfied(report, "legacy"))
        self.assertTrue(preflight.requirement_satisfied(report, "all"))

    def test_pathname_fallback_with_nofollow_stat_remains_usable(self) -> None:
        report = self._report(
            anchored=False,
            nofollow_link=True,
            nofollow_stat=True,
        )
        paths = report["snapshotPaths"]
        for name in ("sourceModel", "legacyTwoSegment", "generatedMultiSegment"):
            self.assertEqual(
                paths[name],
                {"usable": True, "mode": preflight.MODE_PATHNAME_FALLBACK},
            )
        self.assertTrue(preflight.requirement_satisfied(report, "all"))

    def test_host_without_nofollow_hardlinks_is_unsupported(self) -> None:
        report = self._report(
            anchored=False,
            nofollow_link=False,
            nofollow_stat=True,
        )
        paths = report["snapshotPaths"]
        for name in ("sourceModel", "legacyTwoSegment", "generatedMultiSegment"):
            self.assertEqual(
                paths[name],
                {"usable": False, "mode": preflight.MODE_UNSUPPORTED},
            )
        self.assertFalse(preflight.requirement_satisfied(report, "all"))

    def test_cli_emits_json_and_gates_requested_path(self) -> None:
        with (
            mock.patch.object(preflight, "component_walk_supported", return_value=False),
            mock.patch.object(preflight, "nofollow_hardlink_supported", return_value=True),
            mock.patch.object(preflight, "nofollow_stat_supported", return_value=False),
        ):
            generated_output = StringIO()
            with redirect_stdout(generated_output):
                generated_exit = preflight.main(["--require", "generated"])
            source_output = StringIO()
            with redirect_stdout(source_output):
                source_exit = preflight.main(["--require", "source", "--pretty"])

        self.assertEqual(generated_exit, 0)
        self.assertEqual(source_exit, 0)
        generated_report = json.loads(generated_output.getvalue())
        source_report = json.loads(source_output.getvalue())
        self.assertEqual(generated_report, source_report)
        for name in ("sourceModel", "legacyTwoSegment", "generatedMultiSegment"):
            self.assertEqual(
                generated_report["snapshotPaths"][name]["mode"],
                preflight.MODE_PATHNAME_FALLBACK,
            )

    def test_unknown_requirement_is_rejected(self) -> None:
        report = self._report(
            anchored=True,
            nofollow_link=True,
            nofollow_stat=True,
        )
        with self.assertRaisesRegex(ValueError, "unknown execution-snapshot requirement"):
            preflight.requirement_satisfied(report, "other")


if __name__ == "__main__":
    unittest.main()
