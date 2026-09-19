from __future__ import annotations

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


class NumericalVerifierManifestSnapshotTest(unittest.TestCase):
    @staticmethod
    def _reject_non_regular_manifest(manifest_path: Path):
        raise ValueError(f"split manifest must be a regular file: {manifest_path}")

    def test_logits_verifier_rejects_manifest_snapshot_failure_before_ort(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            manifest = root / "split-manifest.json"
            manifest.write_text("{}", encoding="utf-8")

            with (
                mock.patch.object(
                    logits_verifier,
                    "_verified_artifact_execution_snapshot",
                    side_effect=self._reject_non_regular_manifest,
                ) as snapshot,
                mock.patch.object(logits_verifier.ort, "InferenceSession") as session,
            ):
                with self.assertRaisesRegex(ValueError, "regular file"):
                    logits_verifier.verify_multi_split(source, manifest, [1])

            snapshot.assert_called_once_with(manifest)
            session.assert_not_called()

    def test_kv_verifier_rejects_manifest_snapshot_failure_before_ort(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            manifest = root / "split-manifest.json"
            manifest.write_text("{}", encoding="utf-8")

            with (
                mock.patch.object(
                    kv_verifier,
                    "_verified_artifact_execution_snapshot",
                    side_effect=self._reject_non_regular_manifest,
                ) as snapshot,
                mock.patch.object(kv_verifier.ort, "InferenceSession") as session,
            ):
                with self.assertRaisesRegex(ValueError, "regular file"):
                    kv_verifier.verify_multi_segment_kv_decode(source, manifest, [1], 2)

            snapshot.assert_called_once_with(manifest)
            session.assert_not_called()


if __name__ == "__main__":
    unittest.main()
