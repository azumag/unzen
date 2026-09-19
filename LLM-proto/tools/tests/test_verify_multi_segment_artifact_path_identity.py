from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_artifacts as verifier  # noqa: E402


class VerifyMultiSegmentArtifactPathIdentityTest(unittest.TestCase):
    def _replace_after_open_with_same_bytes(self, target: Path, replacement: Path):
        original_open = os.open
        replaced = False

        def replace_after_open(path, flags, *args, **kwargs):
            nonlocal replaced
            fd = original_open(path, flags, *args, **kwargs)
            if Path(path) == target and not replaced:
                os.replace(replacement, target)
                replaced = True
            return fd

        return replace_after_open, lambda: replaced

    def test_manifest_same_content_inode_replacement_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = root / "split-manifest.json"
            replacement = root / "replacement.json"
            payload = b'{"schemaVersion":"1.0.0"}'
            manifest.write_bytes(payload)
            replacement.write_bytes(payload)
            replace_after_open, was_replaced = self._replace_after_open_with_same_bytes(
                manifest, replacement
            )

            with patch("verify_multi_segment_artifacts.os.open", replace_after_open):
                with self.assertRaisesRegex(RuntimeError, "split manifest changed while being read"):
                    verifier._read_stable_manifest(manifest)

            self.assertTrue(was_replaced())
            self.assertEqual(manifest.read_bytes(), payload)

    def test_artifact_same_content_inode_replacement_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact = root / "segment.onnx"
            replacement = root / "replacement.onnx"
            payload = b"same-content-different-inode"
            artifact.write_bytes(payload)
            replacement.write_bytes(payload)
            replace_after_open, was_replaced = self._replace_after_open_with_same_bytes(
                artifact, replacement
            )

            with patch("verify_multi_segment_artifacts.os.open", replace_after_open):
                with self.assertRaisesRegex(RuntimeError, "artifact changed while being measured"):
                    verifier._measure_file(artifact, chunk_size=3)

            self.assertTrue(was_replaced())
            self.assertEqual(artifact.read_bytes(), payload)

    def test_stable_manifest_symlink_keeps_existing_compatibility(self) -> None:
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks are not supported")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "manifest-target.json"
            link = root / "split-manifest.json"
            payload = b'{"kind":"stable-symlink"}'
            target.write_bytes(payload)
            try:
                link.symlink_to(target.name)
            except OSError as error:
                self.skipTest(f"symlink creation unavailable: {error}")

            self.assertEqual(verifier._read_stable_manifest(link), payload)

    def test_open_flags_keep_nonblocking_nofollow_cloexec_and_binary_bits(self) -> None:
        fake_nonblock = 1 << 20
        fake_nofollow = 1 << 21
        fake_cloexec = 1 << 22
        fake_binary = 1 << 23
        with (
            patch.object(verifier.os, "O_NONBLOCK", fake_nonblock, create=True),
            patch.object(verifier.os, "O_NOFOLLOW", fake_nofollow, create=True),
            patch.object(verifier.os, "O_CLOEXEC", fake_cloexec, create=True),
            patch.object(verifier.os, "O_BINARY", fake_binary, create=True),
        ):
            flags = verifier._readonly_nonblocking_flags()

        for bit in (fake_nonblock, fake_nofollow, fake_cloexec, fake_binary):
            with self.subTest(bit=bit):
                self.assertEqual(flags & bit, bit)


if __name__ == "__main__":
    unittest.main()
