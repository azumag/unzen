from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_source as source_module  # noqa: E402


@unittest.skipUnless(
    source_module._component_walk_supported(),
    "platform does not support anchored dirfd traversal",
)
class VerifyMultiSegmentCaptureSourceDirfdTest(unittest.TestCase):
    def test_nested_source_file_is_hashed_through_anchored_components(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            nested = root / "weights" / "shard-0"
            nested.mkdir(parents=True)
            target = nested / "model.data"
            target.write_bytes(b"nested-external-data")

            root_fd, root_stat = source_module._open_directory_anchor(root)
            try:
                size, digest = source_module._stable_identity_at(
                    root_fd,
                    ("weights", "shard-0", "model.data"),
                    field="source external data weights/shard-0/model.data",
                )
                source_module._assert_directory_anchor(root, root_stat)
            finally:
                os.close(root_fd)

            self.assertEqual(size, target.stat().st_size)
            self.assertEqual(digest, hashlib.sha256(target.read_bytes()).hexdigest())

    def test_intermediate_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            real = root / "real"
            real.mkdir()
            (real / "model.data").write_bytes(b"data")
            (root / "alias").symlink_to(real.name, target_is_directory=True)

            root_fd, _root_stat = source_module._open_directory_anchor(root)
            try:
                with self.assertRaisesRegex(
                    ValueError,
                    "parent component must not be a symlink",
                ):
                    source_module._stable_identity_at(
                        root_fd,
                        ("alias", "model.data"),
                        field="source external data alias/model.data",
                    )
            finally:
                os.close(root_fd)

    def test_same_content_intermediate_directory_replacement_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            nested = root / "weights"
            nested.mkdir()
            target = nested / "model.data"
            target.write_bytes(b"same-content")

            replacement = root / "replacement"
            replacement.mkdir()
            (replacement / "model.data").write_bytes(b"same-content")

            root_fd, _root_stat = source_module._open_directory_anchor(root)
            real_hasher = source_module._sha256_fd
            replaced = False

            def replacing_hasher(fd: int) -> str:
                nonlocal replaced
                digest = real_hasher(fd)
                if not replaced:
                    replaced = True
                    old = root / "weights-old"
                    nested.rename(old)
                    replacement.rename(nested)
                return digest

            try:
                with patch.object(
                    source_module,
                    "_sha256_fd",
                    side_effect=replacing_hasher,
                ):
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "parent path changed while being hashed",
                    ):
                        source_module._stable_identity_at(
                            root_fd,
                            ("weights", "model.data"),
                            field="source external data weights/model.data",
                        )
            finally:
                os.close(root_fd)

    def test_source_root_replacement_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            parent = Path(raw_dir)
            root = parent / "source"
            root.mkdir()
            root_fd, root_stat = source_module._open_directory_anchor(root)
            old = parent / "source-old"
            root.rename(old)
            root.mkdir()
            try:
                with self.assertRaisesRegex(
                    RuntimeError,
                    "source model directory changed during verification",
                ):
                    source_module._assert_directory_anchor(root, root_stat)
            finally:
                os.close(root_fd)


if __name__ == "__main__":
    unittest.main()
