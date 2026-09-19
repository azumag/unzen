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

import artifact_execution_snapshot as snapshot  # noqa: E402


@unittest.skipUnless(hasattr(os, "link"), "requires hard-link support")
class ArtifactExecutionSnapshotPrelinkTest(unittest.TestCase):
    def test_same_size_mutation_during_parent_setup_fails_before_link(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "segment0.onnx"
            source.write_bytes(b"graph-a")
            accepted = os.lstat(source)
            payload = source.read_bytes()
            entry: dict[str, object] = {
                "field": "segments[0].path",
                "path": "nested/segment0.onnx",
                "absolute": source,
                "parts": ("nested", "segment0.onnx"),
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "identity": (
                    accepted.st_dev,
                    accepted.st_ino,
                    accepted.st_size,
                    accepted.st_mtime_ns,
                    accepted.st_ctime_ns,
                ),
                "parentIdentities": (),
            }
            destination = root / "execution" / "nested" / "segment0.onnx"
            real_mkdir = Path.mkdir
            mutated = False

            def mutate_during_parent_setup(
                path: Path,
                mode: int = 0o777,
                parents: bool = False,
                exist_ok: bool = False,
            ) -> None:
                nonlocal mutated
                real_mkdir(path, mode=mode, parents=parents, exist_ok=exist_ok)
                if path == destination.parent and not mutated:
                    source.write_bytes(b"graph-b")
                    os.utime(
                        source,
                        ns=(accepted.st_atime_ns, accepted.st_mtime_ns),
                    )
                    mutated = True

            with mock.patch.object(Path, "mkdir", new=mutate_during_parent_setup):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "changed after artifact-snapshot preflight",
                ):
                    snapshot._link_verified_artifact_file(entry, destination)

            self.assertTrue(mutated)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
