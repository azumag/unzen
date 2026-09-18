from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_artifact_snapshot as snapshot  # noqa: E402


class ArtifactSnapshotBinaryModeTest(unittest.TestCase):
    def test_fallback_manifest_reader_requests_binary_mode_and_keeps_raw_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "split-manifest.json"
            raw = b'{"line":"one\r\ntwo","control":"\x1a"}\r\n'
            manifest.write_bytes(raw)
            fake_binary_flag = 1 << 29
            real_open = os.open
            observed_flags: list[int] = []

            def capturing_open(path, flags, *args, **kwargs):
                observed_flags.append(flags)
                return real_open(path, flags & ~fake_binary_flag, *args, **kwargs)

            with (
                mock.patch.object(snapshot.os, "O_BINARY", fake_binary_flag, create=True),
                mock.patch.object(snapshot.os, "open", side_effect=capturing_open),
            ):
                captured, identity = snapshot._read_manifest(manifest)

            self.assertEqual(captured, raw)
            self.assertEqual(identity[2], len(raw))
            self.assertTrue(observed_flags)
            self.assertTrue(observed_flags[0] & fake_binary_flag)

    @unittest.skipUnless(
        snapshot._component_walk_supported(),
        "component-anchored dir_fd opens are not supported on this platform",
    )
    def test_anchored_artifact_reader_requests_binary_mode_and_hashes_raw_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "segment0.onnx"
            raw = b"line1\r\nline2\x1a\n"
            artifact.write_bytes(raw)
            root_fd, _root_stat = snapshot._open_directory_anchor(root)
            fake_binary_flag = 1 << 29
            real_open = os.open
            observed_flags: list[int] = []

            def capturing_open(path, flags, *args, **kwargs):
                observed_flags.append(flags)
                return real_open(path, flags & ~fake_binary_flag, *args, **kwargs)

            try:
                with (
                    mock.patch.object(snapshot.os, "O_BINARY", fake_binary_flag, create=True),
                    mock.patch.object(snapshot.os, "open", side_effect=capturing_open),
                ):
                    measured = snapshot._measure(
                        artifact,
                        field="segments[0].path",
                        root_fd=root_fd,
                        parts=(artifact.name,),
                    )
            finally:
                os.close(root_fd)

            self.assertEqual(measured["bytes"], len(raw))
            self.assertEqual(measured["sha256"], hashlib.sha256(raw).hexdigest())
            self.assertTrue(observed_flags)
            self.assertTrue(observed_flags[0] & fake_binary_flag)


if __name__ == "__main__":
    unittest.main()
