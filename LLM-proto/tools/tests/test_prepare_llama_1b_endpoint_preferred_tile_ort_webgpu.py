from pathlib import Path
import hashlib
import os
import sys
import tempfile
import unittest
from unittest import mock

import onnx

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_llama_1b_endpoint_preferred_tile_ort_webgpu as probe


class WebGpuPreparationGraphTest(unittest.TestCase):
    def external(self, model: onnx.ModelProto) -> dict[str, str]:
        tensor = model.graph.initializer[0]
        return {item.key: item.value for item in tensor.external_data}

    def test_embedding_graph_keeps_nonzero_payload_offset_external(self) -> None:
        model = probe.build_probe_model(
            mode="embedding", rows=16_032, hidden_size=2_048,
            offset=131_334_144, length=131_334_144,
        )
        self.assertEqual([node.op_type for node in model.graph.node], ["Gather"])
        self.assertEqual(self.external(model), {
            "location": "payload-0000.bin",
            "offset": "131334144",
            "length": "131334144",
        })
        self.assertEqual(list(model.graph.initializer[0].dims), [16_032, 2_048])

    def test_logits_graph_keeps_weight_external(self) -> None:
        model = probe.build_probe_model(
            mode="logits", rows=16_032, hidden_size=2_048,
            offset=0, length=131_334_144,
        )
        self.assertEqual([node.op_type for node in model.graph.node], ["Transpose", "MatMul"])
        self.assertEqual(self.external(model)["location"], "payload-0000.bin")

    def test_rejects_inconsistent_weight_length(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "length mismatch"):
            probe.build_probe_model(
                mode="embedding", rows=16_032, hidden_size=2_048,
                offset=0, length=1,
            )

    def test_rejects_unknown_mode(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "unsupported mode"):
            probe.build_probe_model(
                mode="other", rows=16_032, hidden_size=2_048,
                offset=0, length=131_334_144,
            )


class WebGpuPreparationSourcePinTest(unittest.TestCase):
    def test_source_fd_remains_bound_and_detects_path_replacement(self) -> None:
        payload = b"abcdefgh"
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(probe, "PINNED_EXTERNAL_DATA_BYTES", len(payload)), \
             mock.patch.object(probe, "PINNED_EXTERNAL_DATA_SHA256", digest):
            path = Path(directory) / "source.bin"
            path.write_bytes(payload)
            fd, identity, actual = probe._open_pinned_source(path)
            try:
                self.assertEqual(actual, digest)
                replacement = Path(directory) / "replacement.bin"
                replacement.write_bytes(payload)
                replacement.replace(path)
                self.assertEqual(os.pread(fd, len(payload), 0), payload)
                with self.assertRaisesRegex(RuntimeError, "path identity changed"):
                    probe._assert_source_path_identity(path, identity)
            finally:
                os.close(fd)

    def test_copy_payload_reads_from_pinned_descriptor(self) -> None:
        source = b"0123456789abcdef"
        prefix = source[:8]
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(probe, "PINNED_PAYLOAD0_BYTES", len(prefix)), \
             mock.patch.object(probe, "PINNED_PAYLOAD0_SHA256", hashlib.sha256(prefix).hexdigest()):
            source_path = Path(directory) / "source.bin"
            destination = Path(directory) / "payload-0000.bin"
            source_path.write_bytes(source)
            fd = os.open(source_path, os.O_RDONLY)
            try:
                self.assertEqual(probe._copy_payload0(fd, destination), hashlib.sha256(prefix).hexdigest())
            finally:
                os.close(fd)
            self.assertEqual(destination.read_bytes(), prefix)

    @unittest.skipUnless(hasattr(os, "O_NOFOLLOW"), "platform lacks O_NOFOLLOW")
    def test_rejects_symlink_source(self) -> None:
        payload = b"source"
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(probe, "PINNED_EXTERNAL_DATA_BYTES", len(payload)), \
             mock.patch.object(probe, "PINNED_EXTERNAL_DATA_SHA256", hashlib.sha256(payload).hexdigest()):
            target = Path(directory) / "target.bin"
            link = Path(directory) / "source.bin"
            target.write_bytes(payload)
            link.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "non-symlink"):
                probe._open_pinned_source(link)


if __name__ == "__main__":
    unittest.main()
