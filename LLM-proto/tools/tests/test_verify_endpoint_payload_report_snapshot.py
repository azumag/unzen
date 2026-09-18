from __future__ import annotations

import hashlib
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

import verify_endpoint_payload_materialization as verifier  # noqa: E402


class EndpointPayloadVerifierReportSnapshotTest(unittest.TestCase):
    def test_loads_json_and_digest_from_same_snapshot_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / "report.json"
            raw = b'{"kind":"test","value":1}\n'
            report_path.write_bytes(raw)

            report, digest = verifier._load_json_with_sha256(report_path)

            self.assertEqual(report, {"kind": "test", "value": 1})
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())

    def test_requests_binary_mode_and_hashes_exact_crlf_json_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / "report.json"
            raw = b'{\r\n  "kind": "test",\r\n  "value": 1\r\n}\r\n'
            report_path.write_bytes(raw)
            fake_binary = 1 << 29
            real_open = os.open
            observed_binary = False

            def open_without_fake_binary(path, flags, *args, **kwargs):
                nonlocal observed_binary
                observed_binary = bool(flags & fake_binary)
                return real_open(path, flags & ~fake_binary, *args, **kwargs)

            with (
                mock.patch.object(verifier.os, "O_BINARY", fake_binary, create=True),
                mock.patch.object(
                    verifier.os,
                    "open",
                    side_effect=open_without_fake_binary,
                ),
            ):
                report, digest = verifier._load_json_with_sha256(report_path)

            self.assertTrue(observed_binary)
            self.assertEqual(report, {"kind": "test", "value": 1})
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())

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
                    verifier._load_json_with_sha256(
                        ExpansionMustNotRun(),  # type: ignore[arg-type]
                        max_bytes=limit,  # type: ignore[arg-type]
                    )

    def test_exact_max_bytes_is_accepted_and_smaller_limit_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / "report.json"
            raw = b'{"kind":"test","value":1}\n'
            report_path.write_bytes(raw)

            report, digest = verifier._load_json_with_sha256(
                report_path,
                max_bytes=len(raw),
            )
            self.assertEqual(report, {"kind": "test", "value": 1})
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())

            with self.assertRaisesRegex(RuntimeError, "exceeds"):
                verifier._load_json_with_sha256(
                    report_path,
                    max_bytes=len(raw) - 1,
                )

    def test_rejects_path_replacement_between_check_and_open(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report_path = root / "report.json"
            displaced = root / "report-original.json"
            report_path.write_text('{"kind":"original"}', encoding="utf-8")
            original_open = os.open
            replaced = False

            def replace_then_open(path, flags, *args, **kwargs):
                nonlocal replaced
                if Path(path) == report_path and not replaced:
                    report_path.rename(displaced)
                    report_path.write_text('{"kind":"replacement"}', encoding="utf-8")
                    replaced = True
                return original_open(path, flags, *args, **kwargs)

            with (
                mock.patch.object(verifier.os, "open", side_effect=replace_then_open),
                self.assertRaisesRegex(RuntimeError, "changed between path check and open"),
            ):
                verifier._load_json_with_sha256(report_path)

            self.assertTrue(replaced)

    def test_rejects_in_place_mutation_while_reading(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / "report.json"
            report_path.write_text(json.dumps({"payload": "x" * 4096}), encoding="utf-8")
            original_read = os.read
            mutated = False

            def read_then_mutate(fd: int, count: int) -> bytes:
                nonlocal mutated
                data = original_read(fd, count)
                if data and not mutated:
                    report_path.write_text(json.dumps({"payload": "mutated"}), encoding="utf-8")
                    mutated = True
                return data

            with (
                mock.patch.object(verifier.os, "read", side_effect=read_then_mutate),
                self.assertRaisesRegex(RuntimeError, "changed while being read"),
            ):
                verifier._load_json_with_sha256(report_path)

            self.assertTrue(mutated)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO is not supported on this platform")
    def test_rejects_non_regular_report_without_opening_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / "report.fifo"
            os.mkfifo(report_path)

            with (
                mock.patch.object(verifier.os, "open", wraps=os.open) as open_mock,
                self.assertRaisesRegex(RuntimeError, "must be a regular file"),
            ):
                verifier._load_json_with_sha256(report_path)

            open_mock.assert_not_called()

    def test_main_rejects_invalid_probe_report_before_verification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "model_q4.onnx_data"
            source.write_bytes(b"unused")
            probe_report = root / "probe-directory"
            probe_report.mkdir()
            materialization_report = root / "materialization.json"
            materialization_report.write_text("{}", encoding="utf-8")
            payload_dir = root / "payloads"
            payload_dir.mkdir()

            argv = [
                "verify_endpoint_payload_materialization.py",
                str(source),
                str(probe_report),
                str(materialization_report),
                str(payload_dir),
                "--stage",
                "embedding-prefix",
                "--tier",
                "preferred",
            ]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(verifier, "verify_pinned_probe_materialization") as verify_mock,
                self.assertRaisesRegex(RuntimeError, "must be a regular file"),
            ):
                verifier.main()

            verify_mock.assert_not_called()

    def test_main_rejects_invalid_materialization_report_before_verification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "model_q4.onnx_data"
            source.write_bytes(b"unused")
            probe_report = root / "probe.json"
            probe_report.write_text("{}", encoding="utf-8")
            materialization_report = root / "materialization-directory"
            materialization_report.mkdir()
            payload_dir = root / "payloads"
            payload_dir.mkdir()

            argv = [
                "verify_endpoint_payload_materialization.py",
                str(source),
                str(probe_report),
                str(materialization_report),
                str(payload_dir),
                "--stage",
                "embedding-prefix",
                "--tier",
                "preferred",
            ]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(verifier, "verify_pinned_probe_materialization") as verify_mock,
                self.assertRaisesRegex(RuntimeError, "must be a regular file"),
            ):
                verifier.main()

            verify_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
