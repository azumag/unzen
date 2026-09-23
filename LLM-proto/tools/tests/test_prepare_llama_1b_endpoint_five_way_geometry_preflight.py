from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_llama_1b_endpoint_five_way_tile_ort_webgpu as probe


class FiveWayGeometryPreflightTest(unittest.TestCase):
    def layout(self) -> dict[str, object]:
        physical = []
        for index in range(probe.PHYSICAL_ARTIFACT_COUNT):
            start = index * 32
            physical.append(
                {
                    "index": index,
                    "byteLength": 32,
                    "sourceOffsetBytes": start,
                    "sourceEndOffsetBytesExclusive": start + 32,
                }
            )
        tiles: list[dict[str, object]] = [{} for _ in range(probe.EXECUTION_TILE_COUNT)]
        tiles[probe.SELECTED_TILE_INDEX] = {
            "tileIndex": probe.SELECTED_TILE_INDEX,
            "physicalArtifactCount": 2,
            "startRow": 2,
            "endRowExclusive": 6,
            "rowCount": 4,
            "byteLength": 32,
            "physicalSlices": [
                {
                    "physicalArtifactIndex": 0,
                    "startRow": 2,
                    "endRowExclusive": 4,
                    "rowCount": 2,
                    "artifactByteOffset": 16,
                    "byteLength": 16,
                },
                {
                    "physicalArtifactIndex": 1,
                    "startRow": 4,
                    "endRowExclusive": 6,
                    "rowCount": 2,
                    "artifactByteOffset": 0,
                    "byteLength": 16,
                },
            ],
        }
        return {
            "kind": probe.layout_probe.REPORT_KIND,
            "schemaVersion": probe.layout_probe.REPORT_SCHEMA_VERSION,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": "graph",
            "pinnedSourceExternalDataIdentity": {
                "bytes": probe.preferred_webgpu.PINNED_EXTERNAL_DATA_BYTES,
                "sha256": probe.preferred_webgpu.PINNED_EXTERNAL_DATA_SHA256,
            },
            "rowBytes": 8,
            "candidates": [
                {
                    "physicalArtifactCount": probe.PHYSICAL_ARTIFACT_COUNT,
                    "physicalArtifacts": physical,
                    "executionTiles": tiles,
                }
            ],
        }

    def test_snapshots_required_geometry_into_owned_data(self) -> None:
        layout = self.layout()
        hidden_size, tile, physical = probe._preflight_five_way_tile_geometry(layout)

        self.assertEqual(hidden_size, 2)
        self.assertEqual([artifact["index"] for artifact in physical], [0, 1])
        self.assertEqual(
            [sl["physicalArtifactIndex"] for sl in tile["physicalSlices"]],
            [0, 1],
        )

        candidate = layout["candidates"][0]
        candidate["physicalArtifacts"][0]["sourceOffsetBytes"] = 999
        candidate["executionTiles"][probe.SELECTED_TILE_INDEX]["physicalSlices"][0]["artifactByteOffset"] = 999

        self.assertEqual(physical[0]["sourceOffsetBytes"], 0)
        self.assertEqual(tile["physicalSlices"][0]["artifactByteOffset"], 16)

    def test_rejects_coercible_physical_artifact_index(self) -> None:
        layout = self.layout()
        layout["candidates"][0]["executionTiles"][probe.SELECTED_TILE_INDEX]["physicalSlices"][0][
            "physicalArtifactIndex"
        ] = "0"

        with self.assertRaisesRegex(RuntimeError, "physicalArtifactIndex must be a non-bool integer"):
            probe._preflight_five_way_tile_geometry(layout)

    def test_rejects_slice_gap_even_when_each_slice_is_individually_valid(self) -> None:
        layout = self.layout()
        second = layout["candidates"][0]["executionTiles"][probe.SELECTED_TILE_INDEX]["physicalSlices"][1]
        second["startRow"] = 5
        second["endRowExclusive"] = 7

        with self.assertRaisesRegex(RuntimeError, "row-contiguous and cover the tile exactly"):
            probe._preflight_five_way_tile_geometry(layout)

    def test_rejects_source_range_drift(self) -> None:
        layout = self.layout()
        layout["candidates"][0]["physicalArtifacts"][0]["sourceEndOffsetBytesExclusive"] = 31

        with self.assertRaisesRegex(RuntimeError, "source range mismatch"):
            probe._preflight_five_way_tile_geometry(layout)

    def test_prepare_rejects_geometry_before_opening_or_copying_source_payload(self) -> None:
        layout = self.layout()
        layout["candidates"][0]["executionTiles"][probe.SELECTED_TILE_INDEX]["physicalSlices"][0][
            "physicalArtifactIndex"
        ] = True
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.object(probe.layout_probe, "build_report", return_value=deepcopy(layout)):
                with mock.patch.object(
                    probe.preferred_webgpu,
                    "_open_pinned_source",
                    side_effect=AssertionError("source hash must not run"),
                ) as open_mock:
                    with mock.patch.object(
                        probe,
                        "_copy_source_range",
                        side_effect=AssertionError("source copy must not run"),
                    ) as copy_mock:
                        with self.assertRaisesRegex(RuntimeError, "physicalArtifactIndex must be a non-bool integer"):
                            probe.prepare(root / "model.onnx", root / "source.bin", root / "out")
            open_mock.assert_not_called()
            copy_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
