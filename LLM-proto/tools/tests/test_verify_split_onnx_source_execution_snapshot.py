from __future__ import annotations

from contextlib import contextmanager
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import source_model_execution_snapshot as snapshot_boundary  # noqa: E402
import verify_split_onnx as verifier  # noqa: E402


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _manifest(graph: Path, external: Path) -> dict[str, object]:
    return {
        "sourceModel": {
            "sha256": _sha256(graph),
            "externalData": [
                {
                    "location": external.name,
                    "bytes": external.stat().st_size,
                    "sha256": _sha256(external),
                }
            ],
        },
        "boundary": {"tensors": []},
        "logitsOutput": "logits",
    }


class VerifySplitOnnxSourceExecutionSnapshotTest(unittest.TestCase):
    def test_snapshot_preserves_stable_symlink_and_external_layout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            real_graph = root / "real.onnx"
            requested_graph = root / "model.onnx"
            external = root / "weights.bin"
            real_graph.write_bytes(b"graph-bytes")
            external.write_bytes(b"weight-bytes")
            requested_graph.symlink_to(real_graph.name)
            manifest = _manifest(real_graph, external)

            with snapshot_boundary.verified_source_execution_snapshot(
                requested_graph,
                manifest,
            ) as (report, snapshot_graph):
                self.assertNotEqual(snapshot_graph, requested_graph)
                self.assertEqual(snapshot_graph.read_bytes(), b"graph-bytes")
                self.assertEqual((snapshot_graph.parent / external.name).read_bytes(), b"weight-bytes")
                self.assertEqual(report["graphSha256"], _sha256(real_graph))
                self.assertEqual(report["externalData"][0]["sha256"], _sha256(external))

            self.assertFalse(snapshot_graph.parent.exists())

    def test_snapshot_rejects_in_place_graph_mutation_during_execution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph = root / "model.onnx"
            external = root / "weights.bin"
            graph.write_bytes(b"graph-before")
            external.write_bytes(b"weights")
            manifest = _manifest(graph, external)

            with self.assertRaisesRegex(
                RuntimeError,
                "source graph changed during reference execution",
            ):
                with snapshot_boundary.verified_source_execution_snapshot(graph, manifest) as (
                    _report,
                    snapshot_graph,
                ):
                    snapshot_graph.write_bytes(b"graph-after!")

    def test_legacy_verifier_opens_reference_from_snapshot_path(self) -> None:
        snapshot_path = Path("snapshot/model.onnx")
        full_logits = np.asarray([[[0.25, 0.75]]], dtype=np.float32)
        opened: list[str] = []

        @contextmanager
        def source_snapshot(_path: Path, _manifest: dict[str, object]):
            yield ({"graphSha256": "0" * 64}, snapshot_path)

        class FakeSession:
            def __init__(self, path: str, *, providers: list[str]):
                opened.append(path)
                self.path = path
                self.providers = providers

            def get_inputs(self) -> list[object]:
                return []

            def run(self, outputs: list[str], _feeds: dict[str, object]) -> list[np.ndarray]:
                if not outputs:
                    return []
                return [full_logits.copy()]

        manifest = {
            "boundary": {"tensors": []},
            "logitsOutput": "logits",
        }
        with (
            patch.object(verifier, "_load_manifest_snapshot", return_value=manifest),
            patch.object(
                verifier,
                "verified_source_execution_snapshot",
                side_effect=source_snapshot,
            ),
            patch.object(verifier.ort, "InferenceSession", side_effect=FakeSession),
        ):
            report = verifier.verify_split(
                Path("original/model.onnx"),
                Path("segment0.onnx"),
                Path("segment1.onnx"),
                Path("split-manifest.json"),
                [1],
                atol=0,
                rtol=0,
            )

        self.assertEqual(
            opened,
            [str(snapshot_path), "segment0.onnx", "segment1.onnx"],
        )
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["kind"], "unzen-real-two-segment-same-machine-verification")
        self.assertNotIn("sourceModel", report)

    def test_source_snapshot_failure_happens_before_any_ort_session(self) -> None:
        manifest = {
            "boundary": {"tensors": []},
            "logitsOutput": "logits",
        }
        with (
            patch.object(verifier, "_load_manifest_snapshot", return_value=manifest),
            patch.object(
                verifier,
                "verified_source_execution_snapshot",
                side_effect=RuntimeError("source provenance rejected"),
            ),
            patch.object(verifier.ort, "InferenceSession") as session,
        ):
            with self.assertRaisesRegex(RuntimeError, "source provenance rejected"):
                verifier.verify_split(
                    Path("full.onnx"),
                    Path("segment0.onnx"),
                    Path("segment1.onnx"),
                    Path("split-manifest.json"),
                    [1],
                )

        session.assert_not_called()

    def test_snapshot_module_is_dependency_neutral(self) -> None:
        self.assertNotIn("verify_split_onnx", snapshot_boundary.__dict__)
        self.assertNotIn("verify_multi_segment_onnx", snapshot_boundary.__dict__)
        self.assertNotIn("verify_multi_segment_kv_decode", snapshot_boundary.__dict__)


if __name__ == "__main__":
    unittest.main()
