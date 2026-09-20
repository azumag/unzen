from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_browser_p0 as p0_module  # noqa: E402
import source_file_snapshot as snapshot_module  # noqa: E402


class BrowserP0ArtifactSizeSnapshotTest(unittest.TestCase):
    def test_measures_stable_graph_and_external_data(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "segment0.onnx").write_bytes(b"graph")
            (root / "segment0.onnx_data").write_bytes(b"weights")
            segment = {
                "index": 0,
                "path": "segment0.onnx",
                "externalData": [{
                    "location": "segment0.onnx_data",
                    "bytes": len(b"weights"),
                }],
            }

            self.assertEqual(
                p0_module._artifact_bytes(segment, root),
                len(b"graph") + len(b"weights"),
            )

    def test_original_symlink_retarget_does_not_switch_validated_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            root = workspace / "output"
            root.mkdir()
            checked = root / "checked.onnx"
            checked.write_bytes(b"checked")
            outside = workspace / "outside.onnx"
            outside.write_bytes(b"outside-is-larger")
            link = root / "segment0.onnx"
            try:
                link.symlink_to(checked)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks are unavailable")

            original = p0_module._prepared_artifact_file
            retargeted = False

            def validate_then_retarget(raw: str, output_dir: Path, *, field: str) -> Path:
                nonlocal retargeted
                validated = original(raw, output_dir, field=field)
                if not retargeted:
                    link.unlink()
                    link.symlink_to(outside)
                    retargeted = True
                return validated

            segment = {"index": 0, "path": "segment0.onnx", "externalData": []}
            with mock.patch.object(
                p0_module,
                "_prepared_artifact_file",
                side_effect=validate_then_retarget,
            ):
                observed = p0_module._artifact_bytes(segment, root)

            self.assertTrue(retargeted)
            self.assertEqual(observed, len(b"checked"))

    def test_rejects_resolved_path_replacement_before_open(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "segment0.onnx"
            replacement = root / "replacement.onnx"
            source.write_bytes(b"original")
            replacement.write_bytes(b"replacement-is-larger")
            resolved = source.resolve()
            real_open = snapshot_module.os.open
            replaced = False

            def replace_then_open(path: object, flags: int, *args: object, **kwargs: object) -> int:
                nonlocal replaced
                candidate = Path(os.fspath(path))
                if not replaced and candidate == resolved:
                    source.unlink()
                    replacement.replace(source)
                    replaced = True
                return real_open(path, flags, *args, **kwargs)

            segment = {"index": 0, "path": "segment0.onnx", "externalData": []}
            with mock.patch.object(snapshot_module.os, "open", side_effect=replace_then_open):
                with self.assertRaisesRegex(RuntimeError, "changed between path check and open"):
                    p0_module._artifact_bytes(segment, root)
            self.assertTrue(replaced)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO support is unavailable")
    def test_rejects_fifo_replacement_without_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "segment0.onnx"
            source.write_bytes(b"original")
            resolved = source.resolve()
            real_open = snapshot_module.os.open
            replaced = False

            def fifo_then_open(path: object, flags: int, *args: object, **kwargs: object) -> int:
                nonlocal replaced
                candidate = Path(os.fspath(path))
                if not replaced and candidate == resolved:
                    source.unlink()
                    os.mkfifo(source)
                    replaced = True
                return real_open(path, flags, *args, **kwargs)

            segment = {"index": 0, "path": "segment0.onnx", "externalData": []}
            with mock.patch.object(snapshot_module.os, "open", side_effect=fifo_then_open):
                with self.assertRaisesRegex(RuntimeError, "must remain a regular file"):
                    p0_module._artifact_bytes(segment, root)
            self.assertTrue(replaced)


if __name__ == "__main__":
    unittest.main()
