from __future__ import annotations

import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np


TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import probe_llama_1b_endpoint_layout_candidates as layout_fixture  # noqa: E402
import probe_llama_1b_endpoint_preferred_tile_ort_cpu as probe  # noqa: E402


class PreferredTileOrtCpuProbeTests(unittest.TestCase):
    ROWS = 16
    HIDDEN = 32
    ROW_BYTES = HIDDEN * 4

    def _layout_report(
        self, *, decision_status: str = "diagnostic-only", status: str = "pass"
    ) -> dict[str, object]:
        candidate = layout_fixture._candidate(
            rows=self.ROWS,
            row_bytes=self.ROW_BYTES,
            source_offset_bytes=0,
            physical_count=4,
        )
        return {
            "schemaVersion": layout_fixture.REPORT_SCHEMA_VERSION,
            "kind": layout_fixture.REPORT_KIND,
            "status": status,
            "decisionStatus": decision_status,
            "sourceGraphSha256": "a" * 64,
            "pinnedSourceExternalDataIdentity": {
                "location": "model_q4.onnx_data",
                "sizeBytes": self.ROWS * self.ROW_BYTES,
                "sha256": "b" * 64,
            },
            "rowBytes": self.ROW_BYTES,
            "candidates": [candidate],
        }

    def _write_payloads(self, root: Path) -> dict[int, str]:
        weight = (
            np.arange(self.ROWS * self.HIDDEN, dtype=np.float32)
            .reshape(self.ROWS, self.HIDDEN)
            / np.float32(100.0)
        )
        candidate = self._layout_report()["candidates"][0]
        hashes: dict[int, str] = {}
        for artifact in candidate["physicalArtifacts"]:
            index = artifact["index"]
            start = artifact["startRow"]
            end = artifact["endRowExclusive"]
            raw = np.asarray(weight[start:end], dtype="<f4").tobytes(order="C")
            path = root / f"payload-{index:04d}.bin"
            path.write_bytes(raw)
            self.assertEqual(len(raw), artifact["byteLength"])
            hashes[index] = hashlib.sha256(raw).hexdigest()
        return hashes

    def test_all_eight_tiles_execute_against_four_physical_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hashes = self._write_payloads(root)
            with (
                mock.patch.object(probe.layout_probe, "build_report", return_value=self._layout_report()),
                mock.patch.object(probe, "PINNED_PREFERRED_PAYLOAD_SHA256", hashes),
            ):
                report = probe.build_report(
                    Path("ignored.onnx"), root, tile_indices=list(range(8))
                )

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["decisionStatus"], "diagnostic-only")
        self.assertEqual(report["physicalArtifactCount"], 4)
        self.assertEqual(report["executionTileCount"], 8)
        self.assertEqual(report["hiddenSize"], self.HIDDEN)
        self.assertEqual(report["onnxruntime"]["version"], "1.22.0")
        self.assertEqual(report["environment"]["onnxVersion"], "1.18.0")
        self.assertTrue(report["environment"]["pythonVersion"])
        self.assertTrue(report["environment"]["machine"])
        self.assertEqual(len(report["verifiedPhysicalPayloads"]), 4)
        self.assertEqual(len(report["executedTiles"]), 8)
        for tile in report["executedTiles"]:
            self.assertTrue(tile["embedding"]["exactEqual"])
            self.assertEqual(tile["embedding"]["maxAbsDiff"], 0.0)
            self.assertTrue(tile["logits"]["allClose"])
            self.assertLessEqual(tile["logits"]["maxAbsDiff"], probe.ATOL)

    def test_second_tile_uses_nonzero_offset_inside_first_physical_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hashes = self._write_payloads(root)
            with (
                mock.patch.object(probe.layout_probe, "build_report", return_value=self._layout_report()),
                mock.patch.object(probe, "PINNED_PREFERRED_PAYLOAD_SHA256", hashes),
            ):
                report = probe.build_report(Path("ignored.onnx"), root, tile_indices=[1])

        tile = report["executedTiles"][0]
        self.assertEqual(tile["physicalArtifactIndex"], 0)
        self.assertGreater(tile["artifactByteOffset"], 0)
        self.assertTrue(tile["embedding"]["exactEqual"])
        self.assertTrue(tile["logits"]["allClose"])

    def test_payload_hash_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hashes = self._write_payloads(root)
            hashes[0] = "0" * 64
            with (
                mock.patch.object(probe.layout_probe, "build_report", return_value=self._layout_report()),
                mock.patch.object(probe, "PINNED_PREFERRED_PAYLOAD_SHA256", hashes),
            ):
                with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                    probe.build_report(Path("ignored.onnx"), root, tile_indices=[0])

    def test_payload_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hashes = self._write_payloads(root)
            original = root / "payload-0000.bin"
            target = root / "target.bin"
            original.rename(target)
            original.symlink_to(target.name)
            with (
                mock.patch.object(probe.layout_probe, "build_report", return_value=self._layout_report()),
                mock.patch.object(probe, "PINNED_PREFERRED_PAYLOAD_SHA256", hashes),
            ):
                with self.assertRaisesRegex(RuntimeError, "must not be a symlink"):
                    probe.build_report(Path("ignored.onnx"), root, tile_indices=[0])

    def test_payload_path_replacement_during_execution_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hashes = self._write_payloads(root)
            original_execute = probe._execute_tile

            def execute_then_replace(**kwargs):
                result = original_execute(**kwargs)
                payload = root / "payload-0000.bin"
                moved = root / "payload-0000-original.bin"
                payload.rename(moved)
                payload.write_bytes(moved.read_bytes())
                return result

            with (
                mock.patch.object(probe.layout_probe, "build_report", return_value=self._layout_report()),
                mock.patch.object(probe, "PINNED_PREFERRED_PAYLOAD_SHA256", hashes),
                mock.patch.object(probe, "_execute_tile", side_effect=execute_then_replace),
            ):
                with self.assertRaisesRegex(RuntimeError, "path identity changed during execution"):
                    probe.build_report(Path("ignored.onnx"), root, tile_indices=[0])

    def test_upstream_failure_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hashes = self._write_payloads(root)
            with (
                mock.patch.object(
                    probe.layout_probe,
                    "build_report",
                    return_value=self._layout_report(status="fail"),
                ),
                mock.patch.object(probe, "PINNED_PREFERRED_PAYLOAD_SHA256", hashes),
            ):
                with self.assertRaisesRegex(RuntimeError, "layout report must pass"):
                    probe.build_report(Path("ignored.onnx"), root, tile_indices=[0])

    def test_upstream_decision_promotion_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hashes = self._write_payloads(root)
            with (
                mock.patch.object(
                    probe.layout_probe,
                    "build_report",
                    return_value=self._layout_report(decision_status="approved"),
                ),
                mock.patch.object(probe, "PINNED_PREFERRED_PAYLOAD_SHA256", hashes),
            ):
                with self.assertRaisesRegex(RuntimeError, "must remain diagnostic-only"):
                    probe.build_report(Path("ignored.onnx"), root, tile_indices=[0])

    def test_boolean_tile_index_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_payloads(root)
            with mock.patch.object(
                probe.layout_probe, "build_report", return_value=self._layout_report()
            ):
                with self.assertRaisesRegex(RuntimeError, "tile index must be an integer"):
                    probe.build_report(Path("ignored.onnx"), root, tile_indices=[True])

    def test_duplicate_tile_selection_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_payloads(root)
            with mock.patch.object(
                probe.layout_probe, "build_report", return_value=self._layout_report()
            ):
                with self.assertRaisesRegex(RuntimeError, "must not contain duplicates"):
                    probe.build_report(Path("ignored.onnx"), root, tile_indices=[0, 0])


if __name__ == "__main__":
    unittest.main()
