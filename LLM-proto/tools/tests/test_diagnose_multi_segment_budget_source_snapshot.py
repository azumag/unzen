from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import diagnose_multi_segment_budget as diagnostic  # noqa: E402


class BudgetDiagnosticSourceSnapshotTest(unittest.TestCase):
    def test_captures_bytes_and_digest_from_one_source_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "model.onnx"
            raw = b"graph-snapshot"
            source.write_bytes(raw)

            reported_path, observed, digest = diagnostic._read_source_graph_snapshot(source)

            self.assertEqual(reported_path, source.absolute())
            self.assertEqual(observed, raw)
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())

    def test_rejects_path_replacement_between_check_and_open(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "model.onnx"
            displaced = root / "model-original.onnx"
            source.write_bytes(b"original")
            original_open = os.open
            replaced = False

            def replace_then_open(path, flags, *args, **kwargs):
                nonlocal replaced
                if Path(path) == source and not replaced:
                    source.rename(displaced)
                    source.write_bytes(b"replacement")
                    replaced = True
                return original_open(path, flags, *args, **kwargs)

            with (
                mock.patch.object(diagnostic.os, "open", side_effect=replace_then_open),
                self.assertRaisesRegex(RuntimeError, "changed between path check and open"),
            ):
                diagnostic._read_source_graph_snapshot(source)

            self.assertTrue(replaced)

    def test_rejects_in_place_mutation_while_reading(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "model.onnx"
            source.write_bytes(b"x" * 4096)
            original_read = os.read
            mutated = False

            def read_then_mutate(fd: int, count: int) -> bytes:
                nonlocal mutated
                block = original_read(fd, count)
                if block and not mutated:
                    source.write_bytes(b"mutated")
                    mutated = True
                return block

            with (
                mock.patch.object(diagnostic.os, "read", side_effect=read_then_mutate),
                self.assertRaisesRegex(RuntimeError, "changed while being read"),
            ):
                diagnostic._read_source_graph_snapshot(source)

            self.assertTrue(mutated)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO is not supported on this platform")
    def test_rejects_fifo_without_opening_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "model.onnx"
            os.mkfifo(source)

            with (
                mock.patch.object(diagnostic.os, "open", wraps=os.open) as open_mock,
                self.assertRaisesRegex(RuntimeError, "must resolve to a regular file"),
            ):
                diagnostic._read_source_graph_snapshot(source)

            open_mock.assert_not_called()

    def test_diagnose_parses_the_same_bytes_reported_as_graph_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "model.onnx"
            raw = b"captured-graph"
            source.write_bytes(raw)
            observed_parser_bytes: list[bytes] = []

            def load_model(stream, *, load_external_data: bool):
                self.assertFalse(load_external_data)
                observed_parser_bytes.append(stream.read())
                return object()

            hard = diagnostic.ABSOLUTE_MAX_BYTES
            costs = {(0, 1): hard + 1}
            with (
                mock.patch.object(diagnostic.onnx, "load_model", side_effect=load_model),
                mock.patch.object(diagnostic, "discover_total_layers", return_value=1),
                mock.patch.object(diagnostic, "_span_costs", return_value=costs),
                mock.patch.object(diagnostic, "_initializer_rows", return_value=[]),
                mock.patch.object(
                    diagnostic,
                    "_endpoint_isolation_report",
                    return_value={"available": False, "decisionStatus": "diagnostic-only"},
                ),
            ):
                report = diagnostic.diagnose_model(source)

            self.assertEqual(observed_parser_bytes, [raw])
            self.assertEqual(report["sourceModel"]["graphBytes"], len(raw))
            self.assertEqual(
                report["sourceModel"]["graphSha256"],
                hashlib.sha256(raw).hexdigest(),
            )


if __name__ == "__main__":
    unittest.main()
