from __future__ import annotations

import sys
from pathlib import Path
import unittest
from unittest import mock

TOOLS=Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path: sys.path.insert(0,str(TOOLS))
import probe_llama_1b_endpoint_embedding_composition_ort_cpu as probe


class EndpointEmbeddingCompositionPhysicalSlicePackingTest(unittest.TestCase):
    def _tile_bytes(self) -> int:
        return (probe.VOCAB_ROWS//8)*probe.HIDDEN_SIZE*probe.FLOAT32_BYTES

    def _physical_bytes(self) -> dict[int,int]:
        tile_bytes=self._tile_bytes()
        return {index:tile_bytes*2 for index in range(4)}

    def _execution_tiles(self) -> list[dict[str,object]]:
        tile_rows=probe.VOCAB_ROWS//8
        tile_bytes=self._tile_bytes()
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

    def _route(
        self,
        tiles: list[dict[str,object]],
        physical_bytes: dict[int,int] | None = None,
    ):
        return probe._route_probe_tokens(
            tiles,
            physical_artifact_count=4,
            physical_artifact_bytes=physical_bytes or self._physical_bytes(),
        )

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

    def test_valid_candidate_exactly_packs_every_physical_artifact(self) -> None:
        routed=self._route(self._execution_tiles())
        self.assertEqual(len(routed),8)

    def test_preflight_rejects_in_bounds_overlap_with_unused_suffix(self) -> None:
        tiles=self._execution_tiles()
        tiles[1]["physicalSlices"][0]["artifactByteOffset"]-=probe.FLOAT32_BYTES  # type: ignore[index,operator]

        with self.assertRaisesRegex(RuntimeError,"physical artifact 0 slice packing must be contiguous"):
            self._route(tiles)

    def test_preflight_rejects_missing_prefix_even_when_every_slice_is_in_bounds(self) -> None:
        tiles=self._execution_tiles()
        physical_bytes=self._physical_bytes()
        physical_bytes[0]+=probe.FLOAT32_BYTES
        tiles[0]["physicalSlices"][0]["artifactByteOffset"]+=probe.FLOAT32_BYTES  # type: ignore[index,operator]
        tiles[1]["physicalSlices"][0]["artifactByteOffset"]+=probe.FLOAT32_BYTES  # type: ignore[index,operator]

        with self.assertRaisesRegex(RuntimeError,"physical artifact 0 slice packing must be contiguous"):
            self._route(tiles,physical_bytes)

    def test_preflight_rejects_unused_suffix_after_contiguous_slices(self) -> None:
        tiles=self._execution_tiles()
        physical_bytes=self._physical_bytes()
        physical_bytes[0]+=probe.FLOAT32_BYTES

        with self.assertRaisesRegex(RuntimeError,"physical artifact 0 slice packing must cover physical artifact exactly"):
            self._route(tiles,physical_bytes)

    def test_build_report_rejects_malformed_packing_before_source_work(self) -> None:
        tiles=self._execution_tiles()
        tiles[1]["physicalSlices"][0]["artifactByteOffset"]-=probe.FLOAT32_BYTES  # type: ignore[index,operator]
        with (
            mock.patch.object(probe.layout_probe,"build_report",return_value=self._layout(tiles)),
            mock.patch.object(
                probe,
                "_source_embedding_contract",
                side_effect=AssertionError("source work must not run"),
            ) as source_contract,
        ):
            with self.assertRaisesRegex(RuntimeError,"physical artifact 0 slice packing must be contiguous"):
                probe.build_report(Path("unused-model.onnx"),Path("unused-payloads"))
        source_contract.assert_not_called()


if __name__=="__main__": unittest.main()
