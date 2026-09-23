from copy import deepcopy
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1]
import sys
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_llama_1b_endpoint_preferred_tile_ort_webgpu as probe


class PreferredTileGeometryPreflightTest(unittest.TestCase):
    ROW_BYTES = 8_192
    ROWS = 16_032
    TILE_BYTES = ROW_BYTES * ROWS

    def valid_layout(self) -> dict[str, object]:
        tiles: list[dict[str, object]] = []
        for index in range(probe.EXECUTION_TILE_COUNT):
            start = index * self.ROWS
            end = start + self.ROWS
            tile: dict[str, object] = {
                "tileIndex": index,
                "startRow": start,
                "endRowExclusive": end,
                "rowCount": self.ROWS,
                "byteLength": self.TILE_BYTES,
                "physicalSlices": [],
            }
            if index in probe.SELECTED_TILE_INDICES:
                tile["physicalSlices"] = [
                    {
                        "physicalArtifactIndex": 0,
                        "startRow": start,
                        "endRowExclusive": end,
                        "rowCount": self.ROWS,
                        "artifactByteOffset": index * self.TILE_BYTES,
                        "byteLength": self.TILE_BYTES,
                    }
                ]
            tiles.append(tile)
        return {
            "kind": probe.layout_probe.REPORT_KIND,
            "schemaVersion": probe.layout_probe.REPORT_SCHEMA_VERSION,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "pinnedSourceExternalDataIdentity": {
                "bytes": probe.PINNED_EXTERNAL_DATA_BYTES,
                "sha256": probe.PINNED_EXTERNAL_DATA_SHA256,
            },
            "sourceGraphSha256": "source-graph",
            "rowBytes": self.ROW_BYTES,
            "candidates": [
                {
                    "physicalArtifactCount": probe.PHYSICAL_ARTIFACT_COUNT,
                    "physicalArtifacts": [
                        {"index": 0, "byteLength": probe.PINNED_PAYLOAD0_BYTES},
                        {"index": 1, "byteLength": 1},
                        {"index": 2, "byteLength": 1},
                        {"index": 3, "byteLength": 1},
                    ],
                    "executionTiles": tiles,
                }
            ],
        }

    def test_valid_geometry_returns_owned_selected_snapshot(self) -> None:
        layout = self.valid_layout()
        hidden_size, selected = probe._preflight_preferred_tile_geometry(layout)
        self.assertEqual(hidden_size, self.ROW_BYTES // probe.FLOAT32_BYTES)
        self.assertEqual(
            selected,
            [
                {
                    "tileIndex": 0,
                    "startRow": 0,
                    "endRowExclusive": self.ROWS,
                    "rowCount": self.ROWS,
                    "artifactByteOffset": 0,
                    "byteLength": self.TILE_BYTES,
                },
                {
                    "tileIndex": 1,
                    "startRow": self.ROWS,
                    "endRowExclusive": self.ROWS * 2,
                    "rowCount": self.ROWS,
                    "artifactByteOffset": self.TILE_BYTES,
                    "byteLength": self.TILE_BYTES,
                },
            ],
        )
        tiles = layout["candidates"][0]["executionTiles"]
        tiles[0]["startRow"] = 99
        tiles[0]["physicalSlices"][0]["artifactByteOffset"] = 99
        self.assertEqual(selected[0]["startRow"], 0)
        self.assertEqual(selected[0]["artifactByteOffset"], 0)

    def test_rejects_coercible_row_geometry(self) -> None:
        layout = self.valid_layout()
        layout["candidates"][0]["executionTiles"][0]["startRow"] = "0"
        with self.assertRaisesRegex(RuntimeError, "startRow must be a non-bool integer"):
            probe._preflight_preferred_tile_geometry(layout)

    def test_rejects_row_count_drift(self) -> None:
        layout = self.valid_layout()
        layout["candidates"][0]["executionTiles"][0]["rowCount"] -= 1
        with self.assertRaisesRegex(RuntimeError, "row geometry mismatch"):
            probe._preflight_preferred_tile_geometry(layout)

    def test_rejects_slice_byte_length_drift(self) -> None:
        layout = self.valid_layout()
        layout["candidates"][0]["executionTiles"][0]["physicalSlices"][0]["byteLength"] -= self.ROW_BYTES
        with self.assertRaisesRegex(RuntimeError, "slice byte geometry mismatch"):
            probe._preflight_preferred_tile_geometry(layout)

    def test_rejects_noncontiguous_selected_row_ranges(self) -> None:
        layout = self.valid_layout()
        tile1 = layout["candidates"][0]["executionTiles"][1]
        tile1["startRow"] += 1
        tile1["endRowExclusive"] += 1
        tile1["physicalSlices"][0]["startRow"] += 1
        tile1["physicalSlices"][0]["endRowExclusive"] += 1
        with self.assertRaisesRegex(RuntimeError, "row ranges must be contiguous"):
            probe._preflight_preferred_tile_geometry(layout)

    def test_rejects_noncontiguous_selected_payload_ranges(self) -> None:
        layout = self.valid_layout()
        layout["candidates"][0]["executionTiles"][1]["physicalSlices"][0]["artifactByteOffset"] -= self.ROW_BYTES
        with self.assertRaisesRegex(RuntimeError, "payload ranges must be contiguous"):
            probe._preflight_preferred_tile_geometry(layout)

    def test_prepare_rejects_bad_geometry_before_opening_source(self) -> None:
        layout = self.valid_layout()
        layout["candidates"][0]["executionTiles"][0]["startRow"] = True
        with (
            mock.patch.object(probe.layout_probe, "build_report", return_value=layout),
            mock.patch.object(probe, "_open_pinned_source") as open_source,
        ):
            with self.assertRaisesRegex(RuntimeError, "startRow must be a non-bool integer"):
                probe.prepare(Path("source.onnx"), Path("source.bin"), Path("out"))
        open_source.assert_not_called()

    def test_prepare_uses_owned_snapshot_after_source_open(self) -> None:
        layout = self.valid_layout()
        original = deepcopy(layout)
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "out"
            output_dir.mkdir()

            def open_and_mutate(_: Path):
                tile0 = layout["candidates"][0]["executionTiles"][0]
                tile0["startRow"] = 999
                tile0["endRowExclusive"] = 1_000
                tile0["rowCount"] = 1
                tile0["physicalSlices"][0]["artifactByteOffset"] = 999
                return os.open(os.devnull, os.O_RDONLY), (0, 0, 0, 0, 0), "source-sha"

            with (
                mock.patch.object(probe.layout_probe, "build_report", return_value=layout),
                mock.patch.object(probe, "_open_pinned_source", side_effect=open_and_mutate),
                mock.patch.object(probe, "_copy_payload0", return_value="payload-sha"),
                mock.patch.object(probe, "build_probe_model", return_value=object()),
                mock.patch.object(probe.onnx, "save"),
                mock.patch.object(probe, "_measure_regular_file", return_value=(123, "graph-sha")),
                mock.patch.object(probe, "_assert_source_path_identity"),
            ):
                manifest = probe.prepare(Path("source.onnx"), Path("source.bin"), output_dir)

        expected_tile0 = original["candidates"][0]["executionTiles"][0]
        self.assertEqual(manifest["tiles"][0]["startRow"], expected_tile0["startRow"])
        self.assertEqual(
            manifest["tiles"][0]["endRowExclusive"],
            expected_tile0["endRowExclusive"],
        )
        self.assertEqual(
            manifest["tiles"][0]["artifactByteOffset"],
            expected_tile0["physicalSlices"][0]["artifactByteOffset"],
        )


if __name__ == "__main__":
    unittest.main()
