from __future__ import annotations

import hashlib
import json
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


class VerifyMultiSegmentDeclaredArtifactPathIdentityTest(unittest.TestCase):
    @staticmethod
    def _sha(payload: bytes) -> str:
        return hashlib.sha256(payload).hexdigest()

    def _manifest(
        self,
        root: Path,
        *,
        graph_location: str,
        graph_payload: bytes,
        external_location: str | None = None,
        external_payload: bytes | None = None,
    ) -> Path:
        external_data: list[dict[str, object]] = []
        artifact_bytes = len(graph_payload)
        if external_location is not None:
            assert external_payload is not None
            artifact_bytes += len(external_payload)
            external_data.append(
                {
                    "location": external_location,
                    "bytes": len(external_payload),
                    "sha256": self._sha(external_payload),
                }
            )

        manifest = {
            "schemaVersion": "1.0.0",
            "kind": "unzen-budgeted-multi-segment-onnx",
            "artifactLayout": "per-segment-external-data",
            "splitPlan": {
                "requiredMaxBytes": 4096,
                "maximumGeneratedSegmentBytes": artifact_bytes,
            },
            "browserArtifactBudget": {
                "preferredMaxBytes": 1024,
                "normalMaxBytes": 2048,
                "absoluteMaxBytes": 4096,
                "requiredMaxBytes": 4096,
                "maximumSegmentArtifactBytes": artifact_bytes,
                "segments": [
                    {"index": 0, "artifactBytes": artifact_bytes, "tier": "preferred"}
                ],
            },
            "segments": [
                {
                    "index": 0,
                    "path": graph_location,
                    "sha256": self._sha(graph_payload),
                    "browserArtifactBytes": artifact_bytes,
                    "browserArtifactTier": "preferred",
                    "externalData": external_data,
                }
            ],
        }
        manifest_path = root / "split-manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest_path

    @staticmethod
    def _symlink(link: Path, target: Path) -> None:
        try:
            link.symlink_to(target.name)
        except (OSError, NotImplementedError) as error:
            raise unittest.SkipTest(f"symlink creation unavailable: {error}") from error

    def test_stable_declared_graph_symlink_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            payload = b"stable-declared-graph"
            target = root / "graph-original.onnx"
            target.write_bytes(payload)
            link = root / "segment0.onnx"
            self._symlink(link, target)
            manifest_path = self._manifest(
                root,
                graph_location=link.name,
                graph_payload=payload,
            )

            report = verifier.verify_artifact_integrity(manifest_path)

            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["segments"][0]["path"], link.name)
            self.assertEqual(report["segments"][0]["graphSha256"], self._sha(payload))

    def test_declared_graph_symlink_retarget_after_open_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            payload = b"same-bytes-across-two-targets"
            original = root / "graph-original.onnx"
            replacement = root / "graph-replacement.onnx"
            original.write_bytes(payload)
            replacement.write_bytes(payload)
            link = root / "segment0.onnx"
            self._symlink(link, original)
            manifest_path = self._manifest(
                root,
                graph_location=link.name,
                graph_payload=payload,
            )
            original_open = os.open
            retargeted = False

            def retarget_after_open(path, flags, *args, **kwargs):
                nonlocal retargeted
                fd = original_open(path, flags, *args, **kwargs)
                if Path(path) == original and not retargeted:
                    next_link = root / "segment0.next"
                    next_link.symlink_to(replacement.name)
                    os.replace(next_link, link)
                    retargeted = True
                return fd

            with patch("verify_multi_segment_artifacts.os.open", retarget_after_open):
                with self.assertRaisesRegex(RuntimeError, "artifact changed while being measured"):
                    verifier.verify_artifact_integrity(manifest_path)

            self.assertTrue(retargeted)
            self.assertEqual(link.resolve(), replacement.resolve())

    def test_resolved_target_alias_is_rejected_before_measurement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            payload = b"one-physical-artifact"
            shared = root / "shared.bin"
            shared.write_bytes(payload)
            graph_link = root / "segment0.onnx"
            external_link = root / "segment0.onnx_data"
            self._symlink(graph_link, shared)
            self._symlink(external_link, shared)
            manifest_path = self._manifest(
                root,
                graph_location=graph_link.name,
                graph_payload=payload,
                external_location=external_link.name,
                external_payload=payload,
            )

            with patch.object(verifier, "_measure_file", wraps=verifier._measure_file) as measure:
                with self.assertRaisesRegex(ValueError, "duplicate declared artifact path"):
                    verifier.verify_artifact_integrity(manifest_path)

            measure.assert_not_called()


if __name__ == "__main__":
    unittest.main()
