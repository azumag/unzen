from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_bundle as bundle_module  # noqa: E402


class CaptureBundleDeclaredPathSymlinkTest(unittest.TestCase):
    def test_safe_relative_path_preserves_ordinary_declared_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "same-machine-evidence.json"
            target.write_text('{"status":"pass"}\n', encoding="utf-8")

            observed = bundle_module._safe_relative_path(
                root,
                target.name,
                field="run-summary.evidence.path",
            )

            self.assertEqual(observed, target.absolute())

    @unittest.skipUnless(hasattr(Path, "symlink_to"), "symlinks are unavailable")
    def test_in_bundle_final_symlink_remains_visible_to_json_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "real-evidence.json"
            target.write_text('{"status":"pass"}\n', encoding="utf-8")
            declared = root / "same-machine-evidence.json"
            try:
                declared.symlink_to(target.name)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"symlink creation unavailable: {error}")

            observed = bundle_module._safe_relative_path(
                root,
                declared.name,
                field="run-summary.evidence.path",
            )

            self.assertEqual(observed, declared.absolute())
            self.assertNotEqual(observed, target.resolve())
            with self.assertRaisesRegex(ValueError, "must be a regular file"):
                bundle_module._json_snapshot(observed, field="same-machine evidence")

    @unittest.skipUnless(hasattr(Path, "symlink_to"), "symlinks are unavailable")
    def test_symlink_escape_is_still_rejected_during_containment_check(self) -> None:
        with tempfile.TemporaryDirectory() as root_tmp, tempfile.TemporaryDirectory() as outside_tmp:
            root = Path(root_tmp)
            outside = Path(outside_tmp) / "evidence.json"
            outside.write_text('{"status":"pass"}\n', encoding="utf-8")
            declared = root / "same-machine-evidence.json"
            try:
                declared.symlink_to(outside)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"symlink creation unavailable: {error}")

            with self.assertRaisesRegex(ValueError, "escapes capture directory"):
                bundle_module._safe_relative_path(
                    root,
                    declared.name,
                    field="run-summary.evidence.path",
                )


if __name__ == "__main__":
    unittest.main()
