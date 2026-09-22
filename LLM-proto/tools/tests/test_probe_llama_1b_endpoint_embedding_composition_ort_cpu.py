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
    def test_token_ids_cover_every_execution_tile_and_boundaries(self) -> None:
        self.assertEqual(probe.TOKEN_IDS[0],0)
        self.assertEqual(probe.TOKEN_IDS[-1],probe.VOCAB_ROWS-1)
        tile_rows=probe.VOCAB_ROWS//8
        for tile in range(8):
            start=tile*tile_rows; end=(tile+1)*tile_rows-1
            self.assertIn(start,probe.TOKEN_IDS)
            self.assertIn(end,probe.TOKEN_IDS)

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
