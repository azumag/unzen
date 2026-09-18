from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_artifact_snapshot as snapshot_module  # noqa: E402
import verify_multi_segment_capture_bundle as bundle_module  # noqa: E402


class PersistedCaptureLexicalPathGrammarTest(unittest.TestCase):
    MALFORMED_COMMON = (
        "dir//entry.json",
        "dir/./entry.json",
        "dir/",
        "dir\\\\entry.json",
        "dir/\nentry.json",
        "dir/\x1fentry.json",
        "dir/\x7fentry.json",
    )
    SNAPSHOT_ONLY_MALFORMED = ("dir\\entry.json",)

    def test_bundle_paths_reject_malformed_text_before_resolution(self) -> None:
        root = Path("capture-root")
        for value in self.MALFORMED_COMMON:
            with self.subTest(value=repr(value)):
                with mock.patch.object(
                    Path,
                    "resolve",
                    side_effect=AssertionError("path resolution must not run"),
                ):
                    with self.assertRaisesRegex(ValueError, "unsafe"):
                        bundle_module._safe_relative_path(
                            root,
                            value,
                            field="run-summary.evidence.path",
                        )

    def test_snapshot_paths_reject_malformed_text_before_resolution(self) -> None:
        root = Path("artifact-root")
        for value in self.MALFORMED_COMMON + self.SNAPSHOT_ONLY_MALFORMED:
            with self.subTest(value=repr(value)):
                with mock.patch.object(
                    Path,
                    "resolve",
                    side_effect=AssertionError("path resolution must not run"),
                ):
                    with self.assertRaisesRegex(ValueError, "unsafe"):
                        snapshot_module._safe_path(
                            root,
                            value,
                            field="segments[0].path",
                        )

    def test_valid_nested_unicode_path_remains_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            value = "モデル/重み.bin"

            bundle_path = bundle_module._safe_relative_path(
                root,
                value,
                field="run-summary.evidence.path",
            )
            snapshot_name, snapshot_path, snapshot_parts = snapshot_module._safe_path(
                root,
                value,
                field="segments[0].path",
            )

            self.assertEqual(bundle_path, (root / value).absolute())
            self.assertEqual(snapshot_name, value)
            self.assertEqual(snapshot_path, (root.resolve() / value).absolute())
            self.assertEqual(snapshot_parts, ("モデル", "重み.bin"))


if __name__ == "__main__":
    unittest.main()
