from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import materialize_endpoint_payload_chunks as producer  # noqa: E402
import source_file_snapshot  # noqa: E402
import verify_endpoint_payload_materialization as verifier  # noqa: E402


class EndpointPayloadSourceOpenBoundaryTests(unittest.TestCase):
    @staticmethod
    def _single_chunk(source_name: str, payload_bytes: int) -> list[dict[str, object]]:
        return [
            {
                "chunkIndex": 0,
                "startRow": 0,
                "endRowExclusive": 1,
                "rowCount": 1,
                "sourceLocation": source_name,
                "sourceOffsetBytes": 0,
                "sourceEndOffsetBytesExclusive": payload_bytes,
                "payloadBytes": payload_bytes,
            }
        ]

    def test_regular_source_keeps_exact_raw_byte_hash_and_range(self) -> None:
        payload = b"raw\r\nbytes\x1aafter-control"
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "model_q4.onnx_data"
            output_dir = root / "payloads"
            source.write_bytes(payload)
            chunks = self._single_chunk(source.name, len(payload))

            report = producer.materialize_source_payload_chunks(
                source,
                output_dir,
                chunks,
                buffer_bytes=3,
            )
            full_digest, range_digests = verifier._sha256_file_and_ranges(
                source,
                ranges=[(0, len(payload))],
                buffer_bytes=4,
                expected_stat_signature=verifier._file_stat_signature(source.stat()),
            )

            expected_digest = hashlib.sha256(payload).hexdigest()
            self.assertEqual(report["source"]["sha256"], expected_digest)
            self.assertEqual((output_dir / "payload-0000.bin").read_bytes(), payload)
            self.assertEqual(full_digest, expected_digest)
            self.assertEqual(range_digests, [expected_digest])

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO replacement requires POSIX mkfifo")
    def test_producer_fifo_swap_fails_before_output_directory_creation(self) -> None:
        payload = b"producer-source"
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "model_q4.onnx_data"
            output_dir = root / "payloads"
            source.write_bytes(payload)
            chunks = self._single_chunk(source.name, len(payload))
            real_open = os.open
            swapped = False

            def swap_then_open(
                name: os.PathLike[str] | str,
                flags: int,
                *args: object,
                **kwargs: object,
            ) -> int:
                nonlocal swapped
                if not swapped and Path(name) == source.resolve():
                    swapped = True
                    source.unlink()
                    os.mkfifo(source)
                    self.assertTrue(flags & getattr(os, "O_NONBLOCK", 0))
                return real_open(name, flags, *args, **kwargs)

            with patch.object(source_file_snapshot.os, "open", side_effect=swap_then_open):
                with self.assertRaisesRegex(RuntimeError, "regular file"):
                    producer.materialize_source_payload_chunks(
                        source,
                        output_dir,
                        chunks,
                    )

            self.assertTrue(swapped)
            self.assertFalse(output_dir.exists())

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO replacement requires POSIX mkfifo")
    def test_verifier_fifo_swap_fails_before_accepting_digest(self) -> None:
        payload = b"verifier-source"
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "model_q4.onnx_data"
            source.write_bytes(payload)
            expected_signature = verifier._file_stat_signature(source.stat())
            real_open = os.open
            swapped = False

            def swap_then_open(
                name: os.PathLike[str] | str,
                flags: int,
                *args: object,
                **kwargs: object,
            ) -> int:
                nonlocal swapped
                if not swapped and Path(name) == source.resolve():
                    swapped = True
                    source.unlink()
                    os.mkfifo(source)
                    self.assertTrue(flags & getattr(os, "O_NONBLOCK", 0))
                return real_open(name, flags, *args, **kwargs)

            with patch.object(source_file_snapshot.os, "open", side_effect=swap_then_open):
                with self.assertRaisesRegex(RuntimeError, "regular file"):
                    verifier._sha256_file_and_ranges(
                        source,
                        ranges=[(0, len(payload))],
                        expected_stat_signature=expected_signature,
                    )

            self.assertTrue(swapped)


if __name__ == "__main__":
    unittest.main()
