from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_browser_p0 as p0_module  # noqa: E402


class BrowserP0ArtifactPathPinningTest(unittest.TestCase):
    def test_budget_measurement_keeps_containment_checked_symlink_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            output = workspace / "output"
            output.mkdir()
            checked_target = output / "checked.onnx"
            checked_target.write_bytes(b"checked")
            outside_target = workspace / "outside.onnx"
            outside_target.write_bytes(b"outside-target-is-larger")
            link = output / "segment0.onnx"
            try:
                link.symlink_to(checked_target)
            except OSError as error:
                self.skipTest(f"symlink creation unavailable: {error}")

            original = p0_module._prepared_artifact_file
            retargeted = False

            def validate_then_retarget(raw: str, output_dir: Path, *, field: str) -> Path:
                nonlocal retargeted
                validated = original(raw, output_dir, field=field)
                if not retargeted:
                    link.unlink()
                    link.symlink_to(outside_target)
                    retargeted = True
                return validated

            segment = {"index": 0, "path": "segment0.onnx", "externalData": []}
            with patch.object(
                p0_module,
                "_prepared_artifact_file",
                side_effect=validate_then_retarget,
            ):
                observed = p0_module._artifact_bytes(segment, output)

            self.assertTrue(retargeted)
            self.assertEqual(observed, len(b"checked"))
            self.assertNotEqual(observed, len(b"outside-target-is-larger"))

    def test_validated_artifact_helper_returns_resolved_in_tree_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            target = output / "target.onnx"
            target.write_bytes(b"graph")
            link = output / "segment0.onnx"
            try:
                link.symlink_to(target)
            except OSError as error:
                self.skipTest(f"symlink creation unavailable: {error}")

            validated = p0_module._prepared_artifact_file(
                "segment0.onnx",
                output,
                field="segment graph path",
            )

            self.assertEqual(validated, target.resolve())
            self.assertTrue(validated.is_absolute())


if __name__ == "__main__":
    unittest.main()
