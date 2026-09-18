from pathlib import Path
import hashlib
import sys
import tempfile
import unittest
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_llama_1b_endpoint_preferred_tile_ort_webgpu as probe


class EndpointGraphByteLimitContractTest(unittest.TestCase):
    def test_rejects_malformed_limits_before_path_expansion_for_both_helpers(self) -> None:
        invalid_limits = (
            True,
            False,
            -1,
            1.0,
            float("nan"),
            float("inf"),
            float("-inf"),
            "1",
            object(),
        )
        for helper in (probe._measure_regular_file, probe._sha256_file):
            for byte_limit in invalid_limits:
                with self.subTest(helper=helper.__name__, byte_limit=byte_limit):
                    path = mock.Mock()
                    path.expanduser.side_effect = AssertionError("filesystem path must not be touched")
                    with self.assertRaisesRegex(ValueError, "None or a non-negative integer"):
                        helper(path, byte_limit=byte_limit)
                    path.expanduser.assert_not_called()

    def test_zero_hashes_the_empty_prefix_without_payload_reads(self) -> None:
        payload = b"non-empty-generated-graph"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "graph.onnx"
            path.write_bytes(payload)
            with mock.patch.object(probe.os, "read", side_effect=AssertionError("payload read is not expected")):
                measured_bytes, digest = probe._measure_regular_file(path, byte_limit=0)
                wrapper_digest = probe._sha256_file(path, byte_limit=0)
        expected = hashlib.sha256(b"").hexdigest()
        self.assertEqual(measured_bytes, 0)
        self.assertEqual(digest, expected)
        self.assertEqual(wrapper_digest, expected)

    def test_positive_prefix_and_none_preserve_existing_hashing_semantics(self) -> None:
        payload = b"generated-graph"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "graph.onnx"
            path.write_bytes(payload)
            measured_bytes, digest = probe._measure_regular_file(path, byte_limit=4)
            full_digest = probe._sha256_file(path, byte_limit=None)
        self.assertEqual(measured_bytes, 4)
        self.assertEqual(digest, hashlib.sha256(payload[:4]).hexdigest())
        self.assertEqual(full_digest, hashlib.sha256(payload).hexdigest())

    def test_prefix_beyond_eof_still_fails(self) -> None:
        payload = b"short"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "graph.onnx"
            path.write_bytes(payload)
            with self.assertRaisesRegex(RuntimeError, "unexpected EOF"):
                probe._measure_regular_file(path, byte_limit=len(payload) + 1)
            with self.assertRaisesRegex(RuntimeError, "unexpected EOF"):
                probe._sha256_file(path, byte_limit=len(payload) + 1)


if __name__ == "__main__":
    unittest.main()
