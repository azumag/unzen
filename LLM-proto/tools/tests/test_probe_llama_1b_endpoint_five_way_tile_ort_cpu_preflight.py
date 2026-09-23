from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import probe_llama_1b_endpoint_five_way_tile_ort_cpu as probe  # noqa: E402
import probe_llama_1b_endpoint_layout_candidates as layout_fixture  # noqa: E402


class FiveWayTileOrtCpuPreflightTests(unittest.TestCase):
    ROWS = 40
    ROW_BYTES = 64

    def _layout(self) -> dict[str, object]:
        return {
            "schemaVersion": layout_fixture.REPORT_SCHEMA_VERSION,
            "kind": layout_fixture.REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": "a" * 64,
            "pinnedSourceExternalDataIdentity": {
                "location": "model_q4.onnx_data",
                "bytes": self.ROWS * self.ROW_BYTES,
                "sha256": "b" * 64,
            },
            "rowBytes": self.ROW_BYTES,
            "candidates": [
                layout_fixture._candidate(
                    rows=self.ROWS,
                    row_bytes=self.ROW_BYTES,
                    source_offset_bytes=0,
                    physical_count=5,
                )
            ],
        }

    def test_preflight_snapshots_selected_tiles_and_required_artifacts(self) -> None:
        layout = self._layout()
        hidden_size, crossing, tiles, physical, source_identity = (
            probe._preflight_five_way_cpu_geometry(layout, tile_indices=[1])
        )

        self.assertEqual(hidden_size, self.ROW_BYTES // probe.FLOAT32_BYTES)
        self.assertEqual(crossing, [1, 3, 4, 6])
        self.assertEqual([tile["tileIndex"] for tile in tiles], [1])
        self.assertEqual([artifact["index"] for artifact in physical], [0, 1])
        self.assertEqual(source_identity["sha256"], "b" * 64)

        candidate = layout["candidates"][0]
        original_offset = physical[0]["sourceOffsetBytes"]
        original_slice_offset = tiles[0]["physicalSlices"][0]["artifactByteOffset"]
        candidate["physicalArtifacts"][0]["sourceOffsetBytes"] = 999
        candidate["executionTiles"][1]["physicalSlices"][0]["artifactByteOffset"] = 999
        layout["pinnedSourceExternalDataIdentity"]["sha256"] = "c" * 64

        self.assertEqual(physical[0]["sourceOffsetBytes"], original_offset)
        self.assertEqual(tiles[0]["physicalSlices"][0]["artifactByteOffset"], original_slice_offset)
        self.assertEqual(source_identity["sha256"], "b" * 64)

    def test_rejects_coercible_slice_artifact_index(self) -> None:
        layout = self._layout()
        layout["candidates"][0]["executionTiles"][1]["physicalSlices"][0][
            "physicalArtifactIndex"
        ] = "0"

        with self.assertRaisesRegex(RuntimeError, "physicalArtifactIndex must be an integer"):
            probe._preflight_five_way_cpu_geometry(layout, tile_indices=[1])

    def test_rejects_missing_slice_artifact_index_without_raw_lookup_error(self) -> None:
        layout = self._layout()
        del layout["candidates"][0]["executionTiles"][1]["physicalSlices"][0][
            "physicalArtifactIndex"
        ]

        with self.assertRaisesRegex(RuntimeError, "physicalArtifactIndex must be an integer"):
            probe._preflight_five_way_cpu_geometry(layout, tile_indices=[1])

    def test_rejects_individually_valid_slice_gap(self) -> None:
        layout = self._layout()
        second = layout["candidates"][0]["executionTiles"][1]["physicalSlices"][1]
        second["startRow"] += 1
        second["endRowExclusive"] += 1

        with self.assertRaisesRegex(RuntimeError, "row-contiguous and cover the tile exactly"):
            probe._preflight_five_way_cpu_geometry(layout, tile_indices=[1])

    def test_rejects_physical_source_range_drift(self) -> None:
        layout = self._layout()
        layout["candidates"][0]["physicalArtifacts"][0][
            "sourceEndOffsetBytesExclusive"
        ] -= 1

        with self.assertRaisesRegex(RuntimeError, "source range does not match byteLength"):
            probe._preflight_five_way_cpu_geometry(layout, tile_indices=[1])

    def test_build_report_rejects_geometry_before_source_or_payload_open(self) -> None:
        layout = self._layout()
        layout["candidates"][0]["executionTiles"][1]["physicalSlices"][0][
            "physicalArtifactIndex"
        ] = True

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.object(
                probe.layout_probe, "build_report", return_value=deepcopy(layout)
            ):
                with mock.patch.object(
                    probe.preferred_probe,
                    "_open_pinned_payload",
                    side_effect=AssertionError("pinned payload I/O must not run"),
                ) as open_mock:
                    with self.assertRaisesRegex(RuntimeError, "physicalArtifactIndex must be an integer"):
                        probe.build_report(
                            Path("ignored.onnx"),
                            root / "model_q4.onnx_data",
                            root,
                            tile_indices=[1],
                        )
            open_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
