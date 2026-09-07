from pathlib import Path
import hashlib
import os
import sys
import tempfile
import unittest

import onnx

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_llama_1b_endpoint_five_way_tile_ort_webgpu as probe


class FiveWayWebGpuPreparationGraphTest(unittest.TestCase):
    def slices(self):
        return [
            {
                "physicalArtifactIndex": 0,
                "rowCount": 9_620,
                "artifactByteOffset": 131_334_144,
                "byteLength": 78_807_040,
            },
            {
                "physicalArtifactIndex": 1,
                "rowCount": 6_412,
                "artifactByteOffset": 0,
                "byteLength": 52_527_104,
            },
        ]

    def external(self, tensor: onnx.TensorProto) -> dict[str, str]:
        return {item.key: item.value for item in tensor.external_data}

    def test_embedding_graph_binds_two_payloads_then_concats(self) -> None:
        model = probe.build_probe_model(
            mode="embedding", hidden_size=2_048, tile_rows=16_032, slices=self.slices()
        )
        self.assertEqual([node.op_type for node in model.graph.node], ["Concat", "Gather"])
        self.assertEqual(len(model.graph.initializer), 2)
        self.assertEqual(self.external(model.graph.initializer[0]), {
            "location": "payload-0000.bin",
            "offset": "131334144",
            "length": "78807040",
        })
        self.assertEqual(self.external(model.graph.initializer[1]), {
            "location": "payload-0001.bin",
            "offset": "0",
            "length": "52527104",
        })

    def test_logits_graph_binds_two_payloads_then_concats(self) -> None:
        model = probe.build_probe_model(
            mode="logits", hidden_size=2_048, tile_rows=16_032, slices=self.slices()
        )
        self.assertEqual(
            [node.op_type for node in model.graph.node],
            ["Concat", "Transpose", "MatMul"],
        )

    def test_rejects_slice_row_coverage_mismatch(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "do not reconstruct"):
            probe.build_probe_model(
                mode="embedding", hidden_size=2_048, tile_rows=16_031, slices=self.slices()
            )

    def test_rejects_inconsistent_slice_length(self) -> None:
        slices = self.slices()
        slices[1]["byteLength"] = 1
        with self.assertRaisesRegex(RuntimeError, "length mismatch"):
            probe.build_probe_model(
                mode="embedding", hidden_size=2_048, tile_rows=16_032, slices=slices
            )


class FiveWayWebGpuPreparationCopyTest(unittest.TestCase):
    def test_copy_source_range_hashes_exact_bytes(self) -> None:
        source = b"0123456789abcdef"
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "source.bin"
            destination = Path(directory) / "payload.bin"
            source_path.write_bytes(source)
            fd = os.open(source_path, os.O_RDONLY)
            try:
                digest = probe._copy_source_range(
                    fd, source_offset=4, length=8, destination=destination
                )
            finally:
                os.close(fd)
            expected = source[4:12]
            self.assertEqual(destination.read_bytes(), expected)
            self.assertEqual(digest, hashlib.sha256(expected).hexdigest())

    def test_copy_source_range_fails_closed_on_short_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "source.bin"
            destination = Path(directory) / "payload.bin"
            source_path.write_bytes(b"short")
            fd = os.open(source_path, os.O_RDONLY)
            try:
                with self.assertRaisesRegex(RuntimeError, "unexpected EOF"):
                    probe._copy_source_range(
                        fd, source_offset=2, length=8, destination=destination
                    )
            finally:
                os.close(fd)


if __name__ == "__main__":
    unittest.main()
