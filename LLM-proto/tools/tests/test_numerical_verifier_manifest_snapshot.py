from __future__ import annotations

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

import verify_multi_segment_kv_decode as kv_verifier  # noqa: E402
import verify_multi_segment_onnx as logits_verifier  # noqa: E402


@unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO regression requires os.mkfifo")
class NumericalVerifierManifestSnapshotTest(unittest.TestCase):
    def _replace_with_fifo_after_preflight(self, manifest_path: Path) -> dict[str, object]:
        manifest_path.unlink()
        os.mkfifo(manifest_path)
        return {"manifestSha256": "0" * 64}

    def test_logits_verifier_rejects_non_regular_post_preflight_manifest_before_ort(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            manifest = root / "split-manifest.json"
            manifest.write_text("{}", encoding="utf-8")

            with (
                mock.patch.object(
                    logits_verifier,
                    "verify_artifact_integrity",
                    side_effect=self._replace_with_fifo_after_preflight,
                ),
                mock.patch.object(logits_verifier.ort, "InferenceSession") as session,
            ):
                with self.assertRaisesRegex(ValueError, "regular file"):
                    logits_verifier.verify_multi_split(source, manifest, [1])

            session.assert_not_called()

    def test_kv_verifier_rejects_non_regular_post_preflight_manifest_before_ort(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            manifest = root / "split-manifest.json"
            manifest.write_text("{}", encoding="utf-8")

            with (
                mock.patch.object(
                    kv_verifier,
                    "verify_artifact_integrity",
                    side_effect=self._replace_with_fifo_after_preflight,
                ),
                mock.patch.object(kv_verifier.ort, "InferenceSession") as session,
            ):
                with self.assertRaisesRegex(ValueError, "regular file"):
                    kv_verifier.verify_multi_segment_kv_decode(source, manifest, [1], 2)

            session.assert_not_called()


if __name__ == "__main__":
    unittest.main()
