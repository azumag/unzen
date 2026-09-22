from __future__ import annotations
import os
import sys
import tempfile
from pathlib import Path
import unittest
from unittest import mock

TOOLS=Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path: sys.path.insert(0,str(TOOLS))
import multi_segment_onnx
import probe_llama_1b_endpoint_embedding_composition_ort_cpu as probe

class EndpointEmbeddingCompositionContractTest(unittest.TestCase):
    def _execution_tiles(self) -> list[dict[str,object]]:
        tile_rows=probe.VOCAB_ROWS//8
        return [
            {
                "tileIndex": index,
                "startRow": index*tile_rows,
                "endRowExclusive": (index+1)*tile_rows,
                "physicalSlices": [{"physicalArtifactIndex": index//2}],
            }
            for index in range(8)
        ]

    def _physical_artifacts(self) -> list[dict[str,object]]:
        return [
            {"index":index,"byteLength":262_668_288}
            for index in range(4)
        ]

    def _layout(self, *, physical: list[object] | None = None) -> dict[str,object]:
        return {
            "kind": probe.layout_probe.REPORT_KIND,
            "schemaVersion": probe.layout_probe.REPORT_SCHEMA_VERSION,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "candidates": [
                {
                    "physicalArtifactCount": 4,
                    "executionTiles": self._execution_tiles(),
                    "physicalArtifacts": self._physical_artifacts() if physical is None else physical,
                }
            ],
        }

    def test_token_ids_cover_every_execution_tile_and_boundaries(self) -> None:
        self.assertEqual(probe.TOKEN_IDS[0],0)
        self.assertEqual(probe.TOKEN_IDS[-1],probe.VOCAB_ROWS-1)
        tile_rows=probe.VOCAB_ROWS//8
        for tile in range(8):
            start=tile*tile_rows; end=(tile+1)*tile_rows-1
            self.assertIn(start,probe.TOKEN_IDS)
            self.assertIn(end,probe.TOKEN_IDS)

    def test_physical_artifact_preflight_snapshots_indexed_byte_lengths(self) -> None:
        self.assertEqual(
            probe._snapshot_physical_artifacts(self._physical_artifacts()),
            {0:262_668_288,1:262_668_288,2:262_668_288,3:262_668_288},
        )

    def test_physical_artifact_preflight_rejects_non_object_entry(self) -> None:
        physical: list[object]=self._physical_artifacts()
        physical[0]="not-an-object"
        with self.assertRaisesRegex(RuntimeError,"physical artifact must be object"):
            probe._snapshot_physical_artifacts(physical)

    def test_physical_artifact_preflight_rejects_invalid_indexes(self) -> None:
        malformed=(None,True,-1,4,1.5,"0")
        for index in malformed:
            with self.subTest(index=index):
                physical=self._physical_artifacts()
                physical[0]["index"]=index
                with self.assertRaisesRegex(RuntimeError,"physical artifact index invalid"):
                    probe._snapshot_physical_artifacts(physical)

    def test_physical_artifact_preflight_rejects_duplicate_index(self) -> None:
        physical=self._physical_artifacts()
        physical[1]["index"]=0
        with self.assertRaisesRegex(RuntimeError,"duplicate physical artifact index 0"):
            probe._snapshot_physical_artifacts(physical)

    def test_physical_artifact_preflight_rejects_invalid_byte_lengths(self) -> None:
        malformed=(None,True,0,-1,1.5,"262668288")
        for byte_length in malformed:
            with self.subTest(byte_length=byte_length):
                physical=self._physical_artifacts()
                physical[0]["byteLength"]=byte_length
                with self.assertRaisesRegex(RuntimeError,"physical artifact 0 byte length invalid"):
                    probe._snapshot_physical_artifacts(physical)

    def test_physical_artifact_preflight_rejects_count_drift(self) -> None:
        with self.assertRaisesRegex(RuntimeError,"physical artifact count drift"):
            probe._snapshot_physical_artifacts(self._physical_artifacts()[:-1])
        for count in (True,0,-1,1.5,"4"):
            with self.subTest(count=count):
                with self.assertRaisesRegex(RuntimeError,"physical artifact count invalid"):
                    probe._snapshot_physical_artifacts(
                        self._physical_artifacts(),
                        expected_count=count,  # type: ignore[arg-type]
                    )

    def test_build_report_rejects_physical_descriptor_before_source_work(self) -> None:
        physical=self._physical_artifacts()
        physical[0]["index"]="0"
        with (
            mock.patch.object(probe.layout_probe,"build_report",return_value=self._layout(physical=physical)),
            mock.patch.object(
                probe,
                "_source_embedding_contract",
                side_effect=AssertionError("source work must not run"),
            ) as source_contract,
        ):
            with self.assertRaisesRegex(RuntimeError,"physical artifact index invalid"):
                probe.build_report(Path("unused-model.onnx"),Path("unused-payloads"))
        source_contract.assert_not_called()

    def test_token_routing_preflight_covers_every_probe_position_once(self) -> None:
        routed=probe._route_probe_tokens(self._execution_tiles())

        self.assertEqual(len(routed),8)
        positions=[position for _,_,_,_,_,tile_positions in routed for position in tile_positions]
        self.assertEqual(sorted(positions),list(range(len(probe.TOKEN_IDS))))
        self.assertEqual(len(positions),len(set(positions)))
        self.assertEqual([physical for _,_,_,_,physical,_ in routed],[0,0,1,1,2,2,3,3])

    def test_token_routing_preflight_rejects_gap(self) -> None:
        tiles=self._execution_tiles()
        tiles[1]["startRow"]=int(tiles[1]["startRow"])+1

        with self.assertRaisesRegex(
            RuntimeError,
            "cover every probe token exactly once",
        ):
            probe._route_probe_tokens(tiles)

    def test_token_routing_preflight_rejects_overlap(self) -> None:
        tiles=self._execution_tiles()
        tiles[1]["startRow"]=int(tiles[1]["startRow"])-1

        with self.assertRaisesRegex(
            RuntimeError,
            "cover every probe token exactly once",
        ):
            probe._route_probe_tokens(tiles)

    def test_token_routing_preflight_rejects_invalid_ranges(self) -> None:
        malformed_ranges=(
            (-1,probe.VOCAB_ROWS//8),
            (0,probe.VOCAB_ROWS+1),
            (1,1),
            (2,1),
        )
        for start,end in malformed_ranges:
            with self.subTest(start=start,end=end):
                tiles=self._execution_tiles()
                tiles[0]["startRow"]=start
                tiles[0]["endRowExclusive"]=end
                with self.assertRaisesRegex(RuntimeError,"tile row range invalid"):
                    probe._route_probe_tokens(tiles)

    def test_token_routing_preflight_rejects_invalid_physical_slices(self) -> None:
        malformed=(
            None,
            [],
            [{"physicalArtifactIndex":0},{"physicalArtifactIndex":1}],
            ["not-an-object"],
        )
        for slices in malformed:
            with self.subTest(slices=slices):
                tiles=self._execution_tiles()
                tiles[0]["physicalSlices"]=slices
                with self.assertRaisesRegex(RuntimeError,"preferred tile slice drift"):
                    probe._route_probe_tokens(tiles)

    def test_token_routing_preflight_rejects_invalid_physical_artifact_indexes(self) -> None:
        malformed=(True,-1,4,1.5,"0",None)
        for index in malformed:
            with self.subTest(index=index):
                tiles=self._execution_tiles()
                slices=tiles[0]["physicalSlices"]
                self.assertIsInstance(slices,list)
                slices[0]["physicalArtifactIndex"]=index  # type: ignore[index]
                with self.assertRaisesRegex(RuntimeError,"physical artifact index drift"):
                    probe._route_probe_tokens(tiles)

    def test_token_routing_preflight_rejects_invalid_physical_artifact_count(self) -> None:
        for count in (True,0,-1,1.5,"4"):
            with self.subTest(count=count):
                with self.assertRaisesRegex(RuntimeError,"physical artifact count invalid"):
                    probe._route_probe_tokens(
                        self._execution_tiles(),
                        physical_artifact_count=count,  # type: ignore[arg-type]
                    )

    def test_source_weight_geometry_is_exact_float32_vocab_matrix(self) -> None:
        self.assertEqual(probe.SOURCE_WEIGHT_BYTES, probe.VOCAB_ROWS*probe.HIDDEN_SIZE*probe.FLOAT32_BYTES)
        self.assertEqual(probe.SOURCE_WEIGHT_BYTES,1_050_673_152)

    def test_report_contract_remains_diagnostic_only(self) -> None:
        self.assertEqual(probe.REPORT_KIND,"unzen-pinned-llama-1b-endpoint-embedding-composition-ort-cpu-probe")
        self.assertEqual(probe.REPORT_SCHEMA_VERSION,"1.0.0")
        self.assertEqual(probe.PINNED_ORT_VERSION,"1.22.0")

    def test_source_graph_snapshot_uses_multi_segment_default_ceiling(self) -> None:
        self.assertEqual(
            probe.DEFAULT_SOURCE_GRAPH_MAX_BYTES,
            multi_segment_onnx.DEFAULT_SOURCE_GRAPH_MAX_BYTES,
        )

    def test_source_graph_snapshot_delegates_bytes_to_shared_reader(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"model.onnx"
            path.write_bytes(b"pathname-bytes-must-not-be-read-by-wrapper")
            resolved=path.resolve()
            payload=b"shared-captured-source-graph"

            with mock.patch.object(
                probe,
                "_read_shared_source_graph_snapshot",
                return_value=(payload,"digest-is-owned-by-shared-reader"),
            ) as shared_reader:
                reported_path,observed=probe._read_source_graph_snapshot(path,max_bytes=123)

            self.assertEqual(reported_path,resolved)
            self.assertEqual(observed,payload)
            shared_reader.assert_called_once_with(resolved,max_bytes=123)

    def test_source_graph_snapshot_returns_regular_file_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"model.onnx"
            payload=b"stable-source-graph"
            path.write_bytes(payload)

            resolved,observed=probe._read_source_graph_snapshot(path)

            self.assertEqual(resolved,path.resolve())
            self.assertEqual(observed,payload)

    def test_source_graph_snapshot_preserves_stable_symlink_path_semantics(self) -> None:
        if not hasattr(os,"symlink"):
            self.skipTest("symlink is unavailable")
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            target=root/"model-real.onnx"
            requested=root/"model.onnx"
            target.write_bytes(b"stable-source-graph")
            try:
                requested.symlink_to(target.name)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error}")

            resolved,observed=probe._read_source_graph_snapshot(requested)

            self.assertEqual(resolved,target.resolve())
            self.assertEqual(observed,b"stable-source-graph")

    def test_source_graph_snapshot_rejects_requested_symlink_retarget(self) -> None:
        if not hasattr(os,"symlink"):
            self.skipTest("symlink is unavailable")
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            original=root/"original.onnx"
            replacement=root/"replacement.onnx"
            requested=root/"model.onnx"
            original.write_bytes(b"original")
            replacement.write_bytes(b"replacement")
            try:
                requested.symlink_to(original.name)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error}")

            def retarget_after_capture(source: Path, *, max_bytes: int) -> tuple[bytes,str]:
                self.assertEqual(source,original.resolve())
                self.assertEqual(max_bytes,probe.DEFAULT_SOURCE_GRAPH_MAX_BYTES)
                requested.unlink()
                requested.symlink_to(replacement.name)
                return b"captured-original","digest"

            with mock.patch.object(
                probe,
                "_read_shared_source_graph_snapshot",
                side_effect=retarget_after_capture,
            ):
                with self.assertRaisesRegex(RuntimeError,"path changed after reading"):
                    probe._read_source_graph_snapshot(requested)

    def test_source_graph_snapshot_rejects_invalid_ceiling_before_filesystem_work(self) -> None:
        missing=Path("/definitely/not/a/real/unzen-model.onnx")
        for malformed in (True,0,-1,1.5,"16"):
            with self.subTest(max_bytes=malformed):
                with self.assertRaisesRegex(ValueError,"max_bytes must be a positive integer"):
                    probe._read_source_graph_snapshot(missing,max_bytes=malformed)  # type: ignore[arg-type]

    def test_source_graph_snapshot_rejects_oversized_file_before_open(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"model.onnx"
            path.write_bytes(b"x"*17)

            with mock.patch.object(probe.os,"open",side_effect=AssertionError("open must not run")):
                with self.assertRaisesRegex(RuntimeError,"source model graph exceeds 16 bytes"):
                    probe._read_source_graph_snapshot(path,max_bytes=16)

    def test_source_graph_snapshot_rejects_replacement_between_stat_and_open(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            path=root/"model.onnx"
            path.write_bytes(b"original-source-graph")
            resolved=path.resolve()
            real_open=os.open
            replaced=False

            def replacing_open(raw_path,flags,*args,**kwargs):
                nonlocal replaced
                if Path(raw_path)==resolved and not replaced:
                    replaced=True
                    path.replace(root/"original.onnx")
                    path.write_bytes(b"replacement-source-graph")
                return real_open(raw_path,flags,*args,**kwargs)

            with mock.patch.object(probe.os,"open",side_effect=replacing_open):
                with self.assertRaisesRegex(RuntimeError,"changed between path check and open"):
                    probe._read_source_graph_snapshot(path)
            self.assertTrue(replaced)

    @unittest.skipUnless(hasattr(os,"mkfifo"),"FIFO test requires os.mkfifo")
    def test_source_graph_snapshot_rejects_non_regular_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"model.onnx"
            os.mkfifo(path)

            with self.assertRaisesRegex(RuntimeError,"must resolve to a regular file"):
                probe._read_source_graph_snapshot(path)

if __name__=='__main__': unittest.main()
