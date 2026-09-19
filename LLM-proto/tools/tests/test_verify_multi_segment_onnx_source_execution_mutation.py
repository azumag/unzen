from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_onnx as verifier  # noqa: E402


@unittest.skipUnless(hasattr(os, "link"), "requires hard-link support")
class VerifyMultiSegmentOnnxSourceExecutionMutationTest(unittest.TestCase):
    @staticmethod
    def _manifest(
        graph_payload: bytes,
        *,
        external_name: str | None = None,
        external_payload: bytes | None = None,
    ) -> dict[str, object]:
        external: list[dict[str, object]] = []
        if external_name is not None:
            assert external_payload is not None
            external.append(
                {
                    "location": external_name,
                    "bytes": len(external_payload),
                    "sha256": hashlib.sha256(external_payload).hexdigest(),
                }
            )
        return {
            "sourceModel": {
                "sha256": hashlib.sha256(graph_payload).hexdigest(),
                "externalData": external,
            }
        }

    def test_in_place_graph_mutation_during_reference_execution_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = b"graph-A"
            source = root / "model.onnx"
            source.write_bytes(original)
            manifest = self._manifest(original)
            snapshot_root: Path | None = None

            with self.assertRaisesRegex(
                RuntimeError,
                "source graph changed during reference execution",
            ):
                with verifier._verified_source_execution_snapshot(source, manifest) as (
                    _report,
                    snapshot_graph,
                ):
                    snapshot_root = snapshot_graph.parent
                    # Path.write_bytes truncates/writes the existing inode. The hard link
                    # therefore sees the same mutation even though pathname identity is stable.
                    source.write_bytes(b"graph-B")

            assert snapshot_root is not None
            self.assertFalse(snapshot_root.exists())

    def test_in_place_external_mutation_during_reference_execution_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"graph"
            external_payload = b"external-A"
            source = root / "model.onnx"
            source.write_bytes(graph_payload)
            external = root / "model.onnx_data"
            external.write_bytes(external_payload)
            manifest = self._manifest(
                graph_payload,
                external_name=external.name,
                external_payload=external_payload,
            )
            snapshot_root: Path | None = None

            with self.assertRaisesRegex(
                RuntimeError,
                "source external data model.onnx_data changed during reference execution",
            ):
                with verifier._verified_source_execution_snapshot(source, manifest) as (
                    _report,
                    snapshot_graph,
                ):
                    snapshot_root = snapshot_graph.parent
                    # Keep the size unchanged so this regression depends on the metadata
                    # generation fingerprint rather than only the byte count.
                    external.write_bytes(b"external-B")

            assert snapshot_root is not None
            self.assertFalse(snapshot_root.exists())


if __name__ == "__main__":
    unittest.main()
