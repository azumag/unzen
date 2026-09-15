from __future__ import annotations

import hashlib
import inspect
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_llama_1b_endpoint_embedding_eight_physical_payloads as eight_payloads
import prepare_llama_1b_endpoint_embedding_tiled_ort_webgpu as tiled
import probe_llama_1b_endpoint_embedding_composition_ort_cpu as embedding_cpu


class EndpointEmbeddingSourceGraphSizeSnapshotTest(unittest.TestCase):
    def _layout(self, graph_bytes: bytes) -> dict[str, object]:
        return {
            "sourceGraphSha256": hashlib.sha256(graph_bytes).hexdigest(),
            "pinnedSourceExternalDataIdentity": {"location": "model_q4.onnx_data"},
        }

    def _model(self) -> SimpleNamespace:
        external_data = [
            SimpleNamespace(key="location", value="model_q4.onnx_data"),
            SimpleNamespace(key="offset", value="0"),
            SimpleNamespace(key="length", value=str(embedding_cpu.SOURCE_WEIGHT_BYTES)),
        ]
        initializer = SimpleNamespace(
            name=embedding_cpu.EMBEDDING_INITIALIZER,
            data_type=embedding_cpu.TensorProto.FLOAT,
            dims=[embedding_cpu.VOCAB_ROWS, embedding_cpu.HIDDEN_SIZE],
            external_data=external_data,
        )
        return SimpleNamespace(graph=SimpleNamespace(initializer=[initializer]))

    def test_byte_length_pin_is_checked_before_onnx_parse(self) -> None:
        graph_bytes = b"stable-graph-snapshot"
        source_model = Path("/tmp/model_q4.onnx")
        with (
            mock.patch.object(
                embedding_cpu,
                "_read_source_graph_snapshot",
                return_value=(source_model, graph_bytes),
            ),
            mock.patch.object(embedding_cpu.onnx, "load_from_string") as load_from_string,
        ):
            with self.assertRaisesRegex(RuntimeError, "source graph byte length mismatch"):
                embedding_cpu._source_embedding_contract(
                    source_model,
                    self._layout(graph_bytes),
                    expected_graph_bytes=len(graph_bytes) + 1,
                )
        load_from_string.assert_not_called()

    def test_existing_call_shape_remains_compatible_without_size_pin(self) -> None:
        graph_bytes = b"stable-graph-snapshot"
        source_model = Path("/tmp/model_q4.onnx")
        with (
            mock.patch.object(
                embedding_cpu,
                "_read_source_graph_snapshot",
                return_value=(source_model, graph_bytes),
            ),
            mock.patch.object(embedding_cpu.onnx, "load_from_string", return_value=self._model()),
        ):
            path, offset, length = embedding_cpu._source_embedding_contract(
                source_model,
                self._layout(graph_bytes),
            )
        self.assertEqual(path, Path("/tmp/model_q4.onnx_data"))
        self.assertEqual(offset, 0)
        self.assertEqual(length, embedding_cpu.SOURCE_WEIGHT_BYTES)

    def test_downstream_preparers_route_size_pin_through_snapshot_contract(self) -> None:
        for prepare in (tiled.prepare, eight_payloads.prepare):
            source = inspect.getsource(prepare)
            self.assertIn("expected_graph_bytes=SOURCE_GRAPH_BYTES", source)
            self.assertNotIn("source_model.stat().st_size", source)


if __name__ == "__main__":
    unittest.main()
