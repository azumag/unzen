from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest


TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import prepare_real_split as repack  # noqa: E402


class RepackDestinationParentAnchorTests(unittest.TestCase):
    @unittest.skipUnless(
        repack._destination_component_walk_supported(),
        "component-anchored destination opens require dir_fd/O_DIRECTORY/O_NOFOLLOW",
    )
    def test_retargeted_visible_parent_cannot_redirect_destination_write(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output_root = root / "output"
            nested = output_root / "nested"
            pinned_nested = output_root / "nested-pinned"
            foreign = root / "foreign"
            nested.mkdir(parents=True)
            foreign.mkdir()
            destination = nested / "segment0.onnx_data"

            parent_fd = repack._open_repack_destination_parent(destination, output_root)
            self.assertIsInstance(parent_fd, int)
            assert parent_fd is not None
            try:
                nested.rename(pinned_nested)
                try:
                    nested.symlink_to(foreign, target_is_directory=True)
                except (OSError, NotImplementedError):
                    self.skipTest("directory symlink creation is unavailable on this platform")

                with repack._open_repack_destination(
                    destination,
                    parent_fd=parent_fd,
                ) as stream:
                    stream.write(b"pinned-parent-payload")
            finally:
                os.close(parent_fd)

            self.assertFalse((foreign / destination.name).exists())
            self.assertEqual(
                (pinned_nested / destination.name).read_bytes(),
                b"pinned-parent-payload",
            )


if __name__ == "__main__":
    unittest.main()
