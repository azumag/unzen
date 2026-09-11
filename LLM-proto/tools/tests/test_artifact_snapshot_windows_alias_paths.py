from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_artifact_snapshot as snapshot_module  # noqa: E402


class ArtifactSnapshotWindowsAliasPathTest(unittest.TestCase):
    def test_rejects_windows_reserved_or_trimmed_component(self) -> None:
        for value in (
            "NUL",
            "nul.bin",
            "weights/CON",
            "weights/com1.onnx",
            "weights/LPT9",
            "weights/COM¹.log",
            "weights/lpt².bin",
            "weights/payload.",
            "weights/payload ",
        ):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    snapshot_module._safe_path(
                        Path.cwd(),
                        value,
                        field="segments[0].path",
                    )

    def test_accepts_portable_nested_relative_path(self) -> None:
        relative = "weights/chunk-0001.bin"
        name, path, parts = snapshot_module._safe_path(
            Path.cwd(),
            relative,
            field="segments[0].path",
        )
        self.assertEqual(name, relative)
        self.assertEqual(path, (Path.cwd().resolve() / relative).absolute())
        self.assertEqual(parts, tuple(Path(relative).parts))


if __name__ == "__main__":
    unittest.main()
