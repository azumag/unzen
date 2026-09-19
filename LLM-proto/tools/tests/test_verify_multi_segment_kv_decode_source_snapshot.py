from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_kv_decode as verifier  # noqa: E402


class VerifyMultiSegmentKvDecodeSourceSnapshotTest(unittest.TestCase):
    @staticmethod
    def _manifest_bytes(graph_payload: bytes) -> bytes:
        return json.dumps(
            {
                "sourceModel": {
                    "sha256": hashlib.sha256(graph_payload).hexdigest(),
                    "externalData": [],
                }
            }
        ).encode("utf-8")

    @staticmethod
    def _contract() -> dict[str, object]:
        return {
            "segments": (
                {
                    "index": 0,
                    "startLayer": 0,
                    "endLayer": 1,
                    "path": Path("segment0.onnx"),
                    "inputs": (),
                    "outputs": ("logits",),
                },
            ),
            "boundaries": (),
            "logitsOutput": "logits",
        }

    @staticmethod
    def _reference_values() -> tuple[np.ndarray, dict[str, np.ndarray]]:
        logits = np.asarray([[[0.1, 0.9]]], dtype=np.float32)
        cache = {
            "present.0.key": np.zeros((1, 1, 1), dtype=np.float32),
            "present.0.value": np.zeros((1, 1, 1), dtype=np.float32),
        }
        return logits, cache

    @staticmethod
    def _artifact_snapshot_context(
        execution_manifest: Path,
        manifest_sha: str,
    ):
        @contextmanager
        def artifact_snapshot(requested_manifest: Path):
            yield {
                "manifestSha256": manifest_sha,
                "integrity": {"manifestSha256": manifest_sha},
            }, execution_manifest

        return artifact_snapshot

    def test_kv_reference_prompt_and_decode_share_snapshot_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"graph"
            source = root / "model.onnx"
            source.write_bytes(graph_payload)
            manifest_bytes = self._manifest_bytes(graph_payload)
            manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
            execution_manifest = root / "artifact-snapshot" / "split-manifest.json"
            logits, cache = self._reference_values()
            opened_paths: list[Path] = []
            full_session = object()

            def open_session(path: str, *, providers: list[str]) -> object:
                self.assertEqual(providers, ["CPUExecutionProvider"])
                opened_paths.append(Path(path))
                return full_session

            with (
                mock.patch.object(
                    verifier,
                    "_verified_artifact_execution_snapshot",
                    side_effect=self._artifact_snapshot_context(execution_manifest, manifest_sha),
                ),
                mock.patch.object(
                    verifier,
                    "_read_stable_manifest",
                    return_value=manifest_bytes,
                ),
                mock.patch.object(
                    verifier,
                    "validate_multi_segment_manifest",
                    return_value=self._contract(),
                ),
                mock.patch.object(
                    verifier.ort,
                    "InferenceSession",
                    side_effect=open_session,
                ),
                mock.patch.object(
                    verifier,
                    "_run_full_step",
                    side_effect=[
                        (logits, cache, 0),
                        (logits, cache, 8),
                    ],
                ) as run_full,
                mock.patch.object(
                    verifier,
                    "_run_split_step",
                    side_effect=[
                        (logits, cache, [], 0),
                        (logits, cache, [], 8),
                    ],
                ),
            ):
                report = verifier.verify_multi_segment_kv_decode(
                    source,
                    root / "split-manifest.json",
                    [1, 2],
                    3,
                    kv_heads=1,
                    head_size=1,
                )

            self.assertEqual(report["status"], "pass")
            self.assertEqual(len(opened_paths), 1)
            self.assertNotEqual(opened_paths[0], source)
            self.assertTrue(opened_paths[0].parent.name.startswith(".unzen-source-execution-"))
            self.assertFalse(opened_paths[0].parent.exists())
            self.assertEqual(run_full.call_count, 2)
            self.assertIs(run_full.call_args_list[0].args[0], full_session)
            self.assertIs(run_full.call_args_list[1].args[0], full_session)

    def test_in_place_source_mutation_during_kv_reference_fails_before_split(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"graph"
            source = root / "model.onnx"
            source.write_bytes(graph_payload)
            manifest_bytes = self._manifest_bytes(graph_payload)
            manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
            execution_manifest = root / "artifact-snapshot" / "split-manifest.json"
            logits, cache = self._reference_values()

            def open_and_mutate(path: str, *, providers: list[str]) -> object:
                self.assertNotEqual(Path(path), source)
                self.assertEqual(providers, ["CPUExecutionProvider"])
                source.write_bytes(b"other")
                return object()

            with (
                mock.patch.object(
                    verifier,
                    "_verified_artifact_execution_snapshot",
                    side_effect=self._artifact_snapshot_context(execution_manifest, manifest_sha),
                ),
                mock.patch.object(
                    verifier,
                    "_read_stable_manifest",
                    return_value=manifest_bytes,
                ),
                mock.patch.object(
                    verifier,
                    "validate_multi_segment_manifest",
                    return_value=self._contract(),
                ),
                mock.patch.object(
                    verifier.ort,
                    "InferenceSession",
                    side_effect=open_and_mutate,
                ),
                mock.patch.object(
                    verifier,
                    "_run_full_step",
                    side_effect=[
                        (logits, cache, 0),
                        (logits, cache, 8),
                    ],
                ),
                mock.patch.object(verifier, "_run_split_step") as run_split,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "source graph changed during reference execution",
                ):
                    verifier.verify_multi_segment_kv_decode(
                        source,
                        root / "split-manifest.json",
                        [1, 2],
                        3,
                        kv_heads=1,
                        head_size=1,
                    )

            run_split.assert_not_called()


if __name__ == "__main__":
    unittest.main()
