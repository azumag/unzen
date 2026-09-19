from __future__ import annotations

import inspect
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_llama_1b_endpoint_embedding_tiled_ort_webgpu as embedding  # noqa: E402
import prepare_llama_1b_endpoint_five_way_tile_ort_webgpu as five_way  # noqa: E402
import prepare_llama_1b_endpoint_poststage_tiled_ort_webgpu as poststage  # noqa: E402


class DownstreamEndpointGraphMetadataSnapshotTest(unittest.TestCase):
    def test_poststage_graph_info_comes_from_snapshot_bound_checker(self) -> None:
        digest = "a" * 64
        path = Path("graph.onnx")
        with mock.patch.object(
            poststage.preferred_webgpu,
            "_measure_regular_file",
            return_value=(123, digest),
        ) as measure:
            info = poststage._graph_info(path)

        self.assertEqual(info, {"file": "graph.onnx", "bytes": 123, "sha256": digest})
        measure.assert_called_once_with(path, check_onnx=True)

    def test_embedding_graph_variants_measure_each_graph_once(self) -> None:
        original_measure = embedding.preferred_webgpu._measure_regular_file
        with tempfile.TemporaryDirectory() as tmp:
            with (
                mock.patch.object(
                    embedding.preferred_webgpu,
                    "_measure_regular_file",
                    wraps=original_measure,
                ) as measure,
                mock.patch.object(
                    embedding.preferred_webgpu,
                    "_sha256_file",
                    side_effect=AssertionError("legacy digest-only path must not be used"),
                ),
            ):
                variants = embedding._write_graph_variants(Path(tmp), hidden_size=2048)

        self.assertEqual(variants, embedding.EXPECTED_GRAPH_VARIANTS)
        self.assertEqual(measure.call_count, len(embedding.EXPECTED_GRAPH_VARIANTS))
        self.assertTrue(all(call.kwargs == {"check_onnx": False} for call in measure.call_args_list))

    def test_embedding_external_data_validation_uses_snapshot_bound_checker(self) -> None:
        source = inspect.getsource(embedding._write_graph_variants)
        self.assertIn("path, check_onnx=verify_external_data", source)
        self.assertNotIn("onnx.checker.check_model(str(path)", source)

    def test_poststage_prepare_has_no_independent_pathname_checker(self) -> None:
        source = inspect.getsource(poststage.prepare)
        self.assertNotIn("onnx.checker.check_model(str(final_norm_graph_path)", source)
        self.assertNotIn("onnx.checker.check_model(str(graph_path)", source)

    def test_five_way_generated_graph_metadata_uses_snapshot_bound_checker(self) -> None:
        source = inspect.getsource(five_way.prepare)
        self.assertIn(
            "graph_path, check_onnx=True",
            source,
        )
        self.assertNotIn("onnx.checker.check_model(str(graph_path)", source)
        self.assertNotIn("graph_path.stat().st_size", source)
        self.assertNotIn("preferred_webgpu._sha256_file(graph_path)", source)


if __name__ == "__main__":
    unittest.main()
