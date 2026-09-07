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

import probe_llama_1b_endpoint_five_way_tile_ort_cpu as probe  # noqa: E402
import probe_llama_1b_endpoint_layout_candidates as layout_fixture  # noqa: E402


class FiveWayTileOrtCpuProbeTests(unittest.TestCase):
    ROWS = 40
    HIDDEN = 16
    ROW_BYTES = HIDDEN * 4

    def _layout_report(
        self,
        *,
        source_sha256: str,
        decision_status: str = "diagnostic-only",
        status: str = "pass",
    ) -> dict[str, object]:
        candidate = layout_fixture._candidate(
            rows=self.ROWS,
            row_bytes=self.ROW_BYTES,
            source_offset_bytes=0,
            physical_count=5,
        )
        return {
            "schemaVersion": layout_fixture.REPORT_SCHEMA_VERSION,
            "kind": layout_fixture.REPORT_KIND,
            "status": status,
            "decisionStatus": decision_status,
            "sourceGraphSha256": "a" * 64,
            "pinnedSourceExternalDataIdentity": {
                "location": "model_q4.onnx_data",
                "bytes": self.ROWS * self.ROW_BYTES,
                "sha256": source_sha256,
            },
            "rowBytes": self.ROW_BYTES,
            "candidates": [candidate],
        }

    def _write_payloads(self, root: Path) -> tuple[Path, str]:
        weight = (
            np.arange(self.ROWS * self.HIDDEN, dtype=np.float32)
            .reshape(self.ROWS, self.HIDDEN)
            / np.float32(100.0)
        )
        source_path = root / "model_q4.onnx_data"
        source_raw = np.asarray(weight, dtype="<f4").tobytes(order="C")
        source_path.write_bytes(source_raw)
        source_sha256 = hashlib.sha256(source_raw).hexdigest()
        candidate = layout_fixture._candidate(
            rows=self.ROWS,
            row_bytes=self.ROW_BYTES,
            source_offset_bytes=0,
            physical_count=5,
        )
        for artifact in candidate["physicalArtifacts"]:
            index = artifact["index"]
            start = artifact["startRow"]
            end = artifact["endRowExclusive"]
            raw = np.asarray(weight[start:end], dtype="<f4").tobytes(order="C")
            path = root / f"payload-{index:04d}.bin"
            path.write_bytes(raw)
            self.assertEqual(len(raw), artifact["byteLength"])
        return source_path, source_sha256

    def test_all_four_boundary_crossing_tiles_execute_from_two_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path, source_sha256 = self._write_payloads(root)
            with mock.patch.object(
                probe.layout_probe,
                "build_report",
                return_value=self._layout_report(source_sha256=source_sha256),
            ):
                report = probe.build_report(Path("ignored.onnx"), source_path, root)

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["decisionStatus"], "diagnostic-only")
        self.assertEqual(report["physicalArtifactCount"], 5)
        self.assertEqual(report["executionTileCount"], 8)
        self.assertEqual(report["boundaryCrossingTileIndices"], [1, 3, 4, 6])
        self.assertEqual(len(report["executedTiles"]), 4)
        self.assertEqual(
            report["verifiedPinnedSourceExternalData"]["sha256"], source_sha256
        )
        self.assertEqual(len(report["verifiedPhysicalPayloads"]), 5)
        self.assertTrue(
            all(
                payload["matchesPinnedSourceRange"]
                for payload in report["verifiedPhysicalPayloads"]
            )
        )
        for tile in report["executedTiles"]:
            self.assertEqual(len(tile["physicalSlices"]), 2)
            self.assertNotEqual(
                tile["physicalSlices"][0]["physicalArtifactIndex"],
                tile["physicalSlices"][1]["physicalArtifactIndex"],
            )
            self.assertTrue(tile["embedding"]["exactEqual"])
            self.assertEqual(tile["embedding"]["maxAbsDiff"], 0.0)
            self.assertTrue(tile["logits"]["allClose"])
            self.assertLessEqual(tile["logits"]["maxAbsDiff"], probe.ATOL)

    def test_single_boundary_crossing_tile_can_be_selected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path, source_sha256 = self._write_payloads(root)
            with mock.patch.object(
                probe.layout_probe,
                "build_report",
                return_value=self._layout_report(source_sha256=source_sha256),
            ):
                report = probe.build_report(
                    Path("ignored.onnx"), source_path, root, tile_indices=[3]
                )

        self.assertEqual([tile["tileIndex"] for tile in report["executedTiles"]], [3])
        self.assertEqual(len(report["verifiedPhysicalPayloads"]), 2)

    def test_non_crossing_tile_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path, source_sha256 = self._write_payloads(root)
            with mock.patch.object(
                probe.layout_probe,
                "build_report",
                return_value=self._layout_report(source_sha256=source_sha256),
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "is not a pinned 5-way boundary-crossing tile"
                ):
                    probe.build_report(
                        Path("ignored.onnx"), source_path, root, tile_indices=[0]
                    )

    def test_source_hash_mismatch_fails_closed_before_payload_execution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path, source_sha256 = self._write_payloads(root)
            with mock.patch.object(
                probe.layout_probe,
                "build_report",
                return_value=self._layout_report(source_sha256="0" * 64),
            ):
                with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                    probe.build_report(
                        Path("ignored.onnx"), source_path, root, tile_indices=[1]
                    )

    def test_payload_hash_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path, source_sha256 = self._write_payloads(root)
            payload = root / "payload-0000.bin"
            raw = bytearray(payload.read_bytes())
            raw[0] ^= 0xFF
            payload.write_bytes(raw)
            with mock.patch.object(
                probe.layout_probe,
                "build_report",
                return_value=self._layout_report(source_sha256=source_sha256),
            ):
                with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                    probe.build_report(
                        Path("ignored.onnx"), source_path, root, tile_indices=[1]
                    )

    def test_upstream_failure_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path, source_sha256 = self._write_payloads(root)
            with mock.patch.object(
                probe.layout_probe,
                "build_report",
                return_value=self._layout_report(source_sha256=source_sha256, status="fail"),
            ):
                with self.assertRaisesRegex(RuntimeError, "layout report must pass"):
                    probe.build_report(
                        Path("ignored.onnx"), source_path, root, tile_indices=[1]
                    )

    def test_upstream_decision_promotion_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path, source_sha256 = self._write_payloads(root)
            with mock.patch.object(
                probe.layout_probe,
                "build_report",
                return_value=self._layout_report(
                    source_sha256=source_sha256, decision_status="approved"
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "must remain diagnostic-only"):
                    probe.build_report(
                        Path("ignored.onnx"), source_path, root, tile_indices=[1]
                    )

    def test_boolean_tile_index_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path, source_sha256 = self._write_payloads(root)
            with mock.patch.object(
                probe.layout_probe,
                "build_report",
                return_value=self._layout_report(source_sha256=source_sha256),
            ):
                with self.assertRaisesRegex(RuntimeError, "tile index must be an integer"):
                    probe.build_report(
                        Path("ignored.onnx"), source_path, root, tile_indices=[True]
                    )

    def test_duplicate_tile_selection_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path, source_sha256 = self._write_payloads(root)
            with mock.patch.object(
                probe.layout_probe,
                "build_report",
                return_value=self._layout_report(source_sha256=source_sha256),
            ):
                with self.assertRaisesRegex(RuntimeError, "must not contain duplicates"):
                    probe.build_report(
                        Path("ignored.onnx"), source_path, root, tile_indices=[1, 1]
                    )


if __name__ == "__main__":
    unittest.main()
