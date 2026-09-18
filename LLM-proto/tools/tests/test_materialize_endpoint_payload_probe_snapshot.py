from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import materialize_endpoint_payload_chunks as materializer  # noqa: E402


class EndpointPayloadProbeSnapshotTest(unittest.TestCase):
    def test_reads_valid_json_object_from_one_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            probe = Path(directory) / "probe.json"
            expected = {"kind": "probe", "decisionStatus": "diagnostic-only"}
            probe.write_text(json.dumps(expected), encoding="utf-8")

            self.assertEqual(materializer._read_probe_report_snapshot(probe), expected)

    def test_invalid_max_bytes_is_rejected_before_path_expansion(self) -> None:
        class ExpansionMustNotRun:
            def expanduser(self):
                raise AssertionError("path expansion reached")

        invalid_limits = (
            True,
            False,
            1.0,
            1.5,
            float("nan"),
            float("inf"),
            float("-inf"),
            0,
            -1,
        )
        for limit in invalid_limits:
            with self.subTest(max_bytes=limit):
                with self.assertRaisesRegex(ValueError, "positive integer"):
                    materializer._read_probe_report_snapshot(
                        ExpansionMustNotRun(),  # type: ignore[arg-type]
                        max_bytes=limit,  # type: ignore[arg-type]
                    )

    def test_exact_max_bytes_is_accepted_and_smaller_limit_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            probe = Path(directory) / "probe.json"
            expected = {"kind": "probe", "decisionStatus": "diagnostic-only"}
            raw = json.dumps(expected).encode("utf-8")
            probe.write_bytes(raw)

            self.assertEqual(
                materializer._read_probe_report_snapshot(
                    probe,
                    max_bytes=len(raw),
                ),
                expected,
            )
            with self.assertRaisesRegex(RuntimeError, "exceeds"):
                materializer._read_probe_report_snapshot(
                    probe,
                    max_bytes=len(raw) - 1,
                )

    def test_rejects_path_replacement_between_check_and_open(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            probe = root / "probe.json"
            displaced = root / "probe-original.json"
            probe.write_text('{"kind":"original"}', encoding="utf-8")
            original_open = os.open
            replaced = False

            def replace_then_open(path, flags, *args, **kwargs):
                nonlocal replaced
                if Path(path) == probe and not replaced:
                    probe.rename(displaced)
                    probe.write_text('{"kind":"replacement"}', encoding="utf-8")
                    replaced = True
                return original_open(path, flags, *args, **kwargs)

            with (
                mock.patch.object(materializer.os, "open", side_effect=replace_then_open),
                self.assertRaisesRegex(RuntimeError, "changed between path check and open"),
            ):
                materializer._read_probe_report_snapshot(probe)

            self.assertTrue(replaced)

    def test_rejects_in_place_mutation_while_reading(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            probe = Path(directory) / "probe.json"
            probe.write_text(json.dumps({"payload": "x" * 4096}), encoding="utf-8")
            original_read = os.read
            mutated = False

            def read_then_mutate(fd: int, count: int) -> bytes:
                nonlocal mutated
                data = original_read(fd, count)
                if data and not mutated:
                    probe.write_text(json.dumps({"payload": "mutated"}), encoding="utf-8")
                    mutated = True
                return data

            with (
                mock.patch.object(materializer.os, "read", side_effect=read_then_mutate),
                self.assertRaisesRegex(RuntimeError, "changed while being read"),
            ):
                materializer._read_probe_report_snapshot(probe)

            self.assertTrue(mutated)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO is not supported on this platform")
    def test_rejects_non_regular_probe_report_without_opening_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            probe = Path(directory) / "probe.fifo"
            os.mkfifo(probe)

            with (
                mock.patch.object(materializer.os, "open", wraps=os.open) as open_mock,
                self.assertRaisesRegex(RuntimeError, "must be a regular file"),
            ):
                materializer._read_probe_report_snapshot(probe)

            open_mock.assert_not_called()

    def test_main_rejects_invalid_probe_before_materialization(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "model_q4.onnx_data"
            source.write_bytes(b"unused")
            probe_directory = root / "probe-directory"
            probe_directory.mkdir()
            output = root / "payloads"

            argv = [
                "materialize_endpoint_payload_chunks.py",
                str(source),
                str(probe_directory),
                str(output),
            ]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(
                    materializer,
                    "materialize_pinned_probe_payload_chunks",
                ) as materialize_mock,
                self.assertRaisesRegex(RuntimeError, "must be a regular file"),
            ):
                materializer.main()

            materialize_mock.assert_not_called()
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
