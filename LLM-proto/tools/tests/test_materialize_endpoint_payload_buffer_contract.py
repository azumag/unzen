from __future__ import annotations

import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import materialize_endpoint_payload_chunks as materializer  # noqa: E402


INVALID_BUFFER_BYTES = (
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


class MaterializeEndpointPayloadBufferContractTest(unittest.TestCase):
    def test_sha256_stream_rejects_invalid_buffer_before_stream_io(self) -> None:
        for value in INVALID_BUFFER_BYTES:
            with self.subTest(buffer_bytes=value):
                stream = io.BytesIO(b"payload")
                with self.assertRaisesRegex(ValueError, "buffer_bytes must be a positive integer"):
                    materializer._sha256_stream(
                        stream,
                        source_path=Path("unused.bin"),
                        buffer_bytes=value,  # type: ignore[arg-type]
                    )

    def test_sha256_file_rejects_invalid_buffer_before_open(self) -> None:
        for value in INVALID_BUFFER_BYTES:
            with self.subTest(buffer_bytes=value):
                with mock.patch.object(
                    Path,
                    "open",
                    side_effect=AssertionError("path must not be opened"),
                ) as open_mock:
                    with self.assertRaisesRegex(
                        ValueError, "buffer_bytes must be a positive integer"
                    ):
                        materializer.sha256_file(
                            Path("missing.bin"),
                            buffer_bytes=value,  # type: ignore[arg-type]
                        )
                    open_mock.assert_not_called()

    def test_combined_pass_rejects_invalid_buffer_before_source_or_destination_io(self) -> None:
        for value in INVALID_BUFFER_BYTES:
            with self.subTest(buffer_bytes=value):
                source = mock.Mock()
                with self.assertRaisesRegex(ValueError, "buffer_bytes must be a positive integer"):
                    materializer._hash_source_and_materialize_ranges(
                        source,
                        [],
                        [],
                        source_path=Path("unused.bin"),
                        buffer_bytes=value,  # type: ignore[arg-type]
                        expected_source_stat_signature=(0, 0, 0, 0, 0),
                    )
                source.fileno.assert_not_called()

    def test_materializer_rejects_invalid_buffer_before_blueprint_or_filesystem_work(self) -> None:
        for value in INVALID_BUFFER_BYTES:
            with self.subTest(buffer_bytes=value):
                with (
                    mock.patch.object(
                        materializer,
                        "validate_source_payload_chunks",
                        side_effect=AssertionError("blueprint must not be evaluated"),
                    ) as validate_mock,
                    mock.patch.object(
                        Path,
                        "is_file",
                        side_effect=AssertionError("filesystem must not be consulted"),
                    ) as is_file_mock,
                ):
                    with self.assertRaisesRegex(
                        ValueError, "buffer_bytes must be a positive integer"
                    ):
                        materializer.materialize_source_payload_chunks(
                            Path("missing.bin"),
                            Path("output"),
                            [],
                            buffer_bytes=value,  # type: ignore[arg-type]
                        )
                    validate_mock.assert_not_called()
                    is_file_mock.assert_not_called()

    def test_pinned_materializer_rejects_invalid_buffer_before_report_validation(self) -> None:
        for value in INVALID_BUFFER_BYTES:
            with self.subTest(buffer_bytes=value):
                with mock.patch.object(
                    materializer,
                    "chunks_from_probe_report",
                    side_effect=AssertionError("report must not be evaluated"),
                ) as chunks_mock:
                    with self.assertRaisesRegex(
                        ValueError, "buffer_bytes must be a positive integer"
                    ):
                        materializer.materialize_pinned_probe_payload_chunks(
                            Path("missing.bin"),
                            Path("output"),
                            {},
                            stage_kind="embedding-prefix",
                            tier="preferred",
                            buffer_bytes=value,  # type: ignore[arg-type]
                        )
                    chunks_mock.assert_not_called()

    def test_positive_integer_buffer_preserves_hash_and_materialized_bytes(self) -> None:
        chunks = [
            {
                "chunkIndex": 0,
                "startRow": 0,
                "endRowExclusive": 2,
                "rowCount": 2,
                "sourceLocation": "weights.bin",
                "sourceOffsetBytes": 0,
                "sourceEndOffsetBytesExclusive": 4,
                "payloadBytes": 4,
            }
        ]
        source_bytes = b"abcd"

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "weights.bin"
            source.write_bytes(source_bytes)
            output_dir = root / "chunks"

            self.assertEqual(
                materializer.sha256_file(source, buffer_bytes=2),
                hashlib.sha256(source_bytes).hexdigest(),
            )
            report = materializer.materialize_source_payload_chunks(
                source,
                output_dir,
                chunks,
                buffer_bytes=2,
            )

            self.assertEqual((output_dir / "payload-0000.bin").read_bytes(), source_bytes)
            self.assertEqual(report["source"]["sha256"], hashlib.sha256(source_bytes).hexdigest())
            self.assertEqual(report["payloads"][0]["sha256"], hashlib.sha256(source_bytes).hexdigest())


if __name__ == "__main__":
    unittest.main()
