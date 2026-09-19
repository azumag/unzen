from __future__ import annotations

import io
from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import probe_p0_smollm2_graph as probe  # noqa: E402


class ProbeP0SmolLM2GraphSnapshotTests(unittest.TestCase):
    def test_load_model_snapshot_parses_captured_bytes(self) -> None:
        path = Path("model_q4.onnx")
        raw = b"captured-onnx-bytes\x00\x1a\r\n"
        parsed = object()

        with mock.patch.object(
            probe,
            "read_regular_file_snapshot",
            return_value=(raw, "digest"),
        ) as snapshot_mock, mock.patch.object(
            probe.onnx,
            "load_model",
            return_value=parsed,
        ) as load_mock:
            result = probe._load_model_snapshot(path)

        self.assertIs(result, parsed)
        snapshot_mock.assert_called_once_with(
            path,
            max_bytes=probe.DEFAULT_SOURCE_GRAPH_MAX_BYTES,
            label="P0 model graph",
        )
        load_mock.assert_called_once()
        args, kwargs = load_mock.call_args
        self.assertEqual(len(args), 1)
        self.assertIsInstance(args[0], io.BytesIO)
        self.assertEqual(args[0].getvalue(), raw)
        self.assertEqual(kwargs, {"load_external_data": False})

    def test_snapshot_failure_prevents_onnx_parse(self) -> None:
        path = Path("replaced-model.onnx")
        with mock.patch.object(
            probe,
            "read_regular_file_snapshot",
            side_effect=RuntimeError("P0 model graph changed while being read"),
        ), mock.patch.object(probe.onnx, "load_model") as load_mock:
            with self.assertRaisesRegex(RuntimeError, "changed while being read"):
                probe._load_model_snapshot(path)

        load_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
