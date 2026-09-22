from __future__ import annotations

import sys
from pathlib import Path
import unittest
from unittest import mock

TOOLS=Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path: sys.path.insert(0,str(TOOLS))
import probe_llama_1b_endpoint_embedding_composition_ort_cpu as probe


class EndpointEmbeddingCompositionSliceGeometryTest(unittest.TestCase):
    def _physical_bytes(self) -> dict[int,int]:
        tile_bytes=(probe.VOCAB_ROWS//8)*probe.HIDDEN_SIZE*probe.FLOAT32_BYTES
        return {index:tile_bytes*2 for index in range(4)}

    def _execution_tiles(self) -> list[dict[str,object]]:
        tile_rows=probe.VOCAB_ROWS//8
        tile_bytes=tile_rows*probe.HIDDEN_SIZE*probe.FLOAT32_BYTES
        return [
            {
                "tileIndex":index,
                "startRow":index*tile_rows,
                "endRowExclusive":(index+1)*tile_rows,
                "rowCount":tile_rows,
                "physicalSlices":[
                    {
                        "physicalArtifactIndex":index//2,
                        "startRow":index*tile_rows,
                        "endRowExclusive":(index+1)*tile_rows,
                        "rowCount":tile_rows,
                        "artifactByteOffset":(index%2)*tile_bytes,
                        "byteLength":tile_bytes,
                    }
                ],
            }
            for index in range(8)
        ]

    def _layout(self, tiles: list[dict[str,object]]) -> dict[str,object]:
        physical_bytes=self._physical_bytes()
        return {
            "kind":probe.layout_probe.REPORT_KIND,
            "schemaVersion":probe.layout_probe.REPORT_SCHEMA_VERSION,
            "status":"pass",
            "decisionStatus":"diagnostic-only",
            "candidates":[
                {
                    "physicalArtifactCount":4,
                    "executionTiles":tiles,
                    "physicalArtifacts":[
                        {"index":index,"byteLength":physical_bytes[index]}
                        for index in range(4)
                    ],
                }
            ],
        }

    def _route(self, tiles: list[dict[str,object]]):
        return probe._route_probe_tokens(
            tiles,
            physical_artifact_count=4,
            physical_artifact_bytes=self._physical_bytes(),
        )

    def test_geometry_preflight_returns_owned_slice_snapshot(self) -> None:
        tiles=self._execution_tiles()
        routed=self._route(tiles)
        snapshot=routed[0][0]
        original_slice=tiles[0]["physicalSlices"][0]  # type: ignore[index]

        self.assertIsNot(snapshot,tiles[0])
        self.assertIsNot(snapshot["physicalSlices"][0],original_slice)  # type: ignore[index]
        self.assertEqual(snapshot["physicalSlices"][0]["rowCount"],probe.VOCAB_ROWS//8)  # type: ignore[index]
        original_slice["rowCount"]=1  # type: ignore[index]
        self.assertEqual(snapshot["physicalSlices"][0]["rowCount"],probe.VOCAB_ROWS//8)  # type: ignore[index]

    def test_geometry_preflight_rejects_coercible_or_invalid_values(self) -> None:
        cases=(
            ("rowCount",True),
            ("rowCount",0),
            ("rowCount",1.5),
            ("rowCount","16032"),
            ("artifactByteOffset",True),
            ("artifactByteOffset",-1),
            ("artifactByteOffset",1.5),
            ("artifactByteOffset","0"),
            ("byteLength",True),
            ("byteLength",0),
            ("byteLength",1.5),
            ("byteLength","131334144"),
        )
        for field,value in cases:
            with self.subTest(field=field,value=value):
                tiles=self._execution_tiles()
                tiles[0]["physicalSlices"][0][field]=value  # type: ignore[index]
                with self.assertRaisesRegex(RuntimeError,"physical slice geometry invalid"):
                    self._route(tiles)

    def test_geometry_preflight_rejects_row_count_drift(self) -> None:
        tiles=self._execution_tiles()
        tiles[0]["physicalSlices"][0]["rowCount"]+=1  # type: ignore[index,operator]
        with self.assertRaisesRegex(RuntimeError,"physical slice row count drift"):
            self._route(tiles)

    def test_geometry_preflight_rejects_tensor_byte_length_drift(self) -> None:
        tiles=self._execution_tiles()
        tiles[0]["physicalSlices"][0]["byteLength"]+=probe.FLOAT32_BYTES  # type: ignore[index,operator]
        with self.assertRaisesRegex(RuntimeError,"physical slice byte length drift"):
            self._route(tiles)

    def test_geometry_preflight_rejects_out_of_bounds_slice(self) -> None:
        tiles=self._execution_tiles()
        physical_bytes=self._physical_bytes()
        physical_bytes[0]-=1
        with self.assertRaisesRegex(RuntimeError,"physical slice exceeds physical artifact bytes"):
            probe._route_probe_tokens(
                tiles,
                physical_artifact_count=4,
                physical_artifact_bytes=physical_bytes,
            )

    def test_build_report_rejects_slice_geometry_before_source_work(self) -> None:
        tiles=self._execution_tiles()
        tiles[0]["physicalSlices"][0]["rowCount"]+=1  # type: ignore[index,operator]
        with (
            mock.patch.object(probe.layout_probe,"build_report",return_value=self._layout(tiles)),
            mock.patch.object(
                probe,
                "_source_embedding_contract",
                side_effect=AssertionError("source work must not run"),
            ) as source_contract,
        ):
            with self.assertRaisesRegex(RuntimeError,"physical slice row count drift"):
                probe.build_report(Path("unused-model.onnx"),Path("unused-payloads"))
        source_contract.assert_not_called()


if __name__=="__main__": unittest.main()
