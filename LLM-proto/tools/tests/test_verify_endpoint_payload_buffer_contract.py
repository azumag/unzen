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

import verify_endpoint_payload_materialization as verifier  # noqa: E402


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


class VerifyEndpointPayloadBufferContractTest(unittest.TestCase):
    def test_payload_hash_rejects_invalid_buffer_before_open(self) -> None:
        for value in INVALID_BUFFER_BYTES:
            with self.subTest(buffer_bytes=value):
                with mock.patch.object(
                    verifier.os,
                    "open",
                    side_effect=AssertionError("payload must not be opened"),
                ) as open_mock:
                    with self.assertRaisesRegex(
                        ValueError, "buffer_bytes must be a positive integer"
                    ):
                        verifier._sha256_payload_at(
                            -1,
                            "payload.bin",
                            path=Path("payload.bin"),
                            buffer_bytes=value,  # type: ignore[arg-type]
                        )
                    open_mock.assert_not_called()

    def test_source_hash_rejects_invalid_buffer_before_range_or_file_io(self) -> None:
        for value in INVALID_BUFFER_BYTES:
            with self.subTest(buffer_bytes=value):
                ranges = mock.MagicMock()
                with mock.patch.object(
                    Path,
                    "open",
                    side_effect=AssertionError("source must not be opened"),
                ) as open_mock:
                    with self.assertRaisesRegex(
                        ValueError, "buffer_bytes must be a positive integer"
                    ):
                        verifier._sha256_file_and_ranges(
                            Path("source.bin"),
                            ranges=ranges,
                            buffer_bytes=value,  # type: ignore[arg-type]
                        )
                    ranges.__iter__.assert_not_called()
                    open_mock.assert_not_called()

    def test_verifier_rejects_invalid_buffer_before_blueprint_or_filesystem_work(self) -> None:
        for value in INVALID_BUFFER_BYTES:
            with self.subTest(buffer_bytes=value):
                expected_chunks = mock.MagicMock()
                with (
                    mock.patch.object(
                        verifier,
                        "_validate_source_payload_chunks",
                        side_effect=AssertionError("blueprint must not be validated"),
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
                        verifier.verify_materialization_payloads(
                            Path("source.bin"),
                            {},
                            Path("payloads"),
                            expected_chunks=expected_chunks,
                            expected_provenance={},
                            expected_source_identity={},
                            buffer_bytes=value,  # type: ignore[arg-type]
                        )
                    expected_chunks.__iter__.assert_not_called()
                    validate_mock.assert_not_called()
                    is_file_mock.assert_not_called()

    def test_pinned_verifier_rejects_invalid_buffer_before_report_validation(self) -> None:
        for value in INVALID_BUFFER_BYTES:
            with self.subTest(buffer_bytes=value):
                with mock.patch.object(
                    verifier,
                    "_chunks_from_probe_report",
                    side_effect=AssertionError("probe report must not be evaluated"),
                ) as chunks_mock:
                    with self.assertRaisesRegex(
                        ValueError, "buffer_bytes must be a positive integer"
                    ):
                        verifier.verify_pinned_probe_materialization(
                            Path("source.bin"),
                            {},
                            {},
                            Path("payloads"),
                            stage_kind="embedding-prefix",
                            tier="preferred",
                            buffer_bytes=value,  # type: ignore[arg-type]
                        )
                    chunks_mock.assert_not_called()

    def test_positive_integer_buffer_preserves_source_and_range_hashes(self) -> None:
        source_bytes = b"abcdef"
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.bin"
            source.write_bytes(source_bytes)

            full_sha256, range_sha256_values = verifier._sha256_file_and_ranges(
                source,
                ranges=[(1, 3)],
                buffer_bytes=2,
            )

            self.assertEqual(full_sha256, hashlib.sha256(source_bytes).hexdigest())
            self.assertEqual(range_sha256_values, [hashlib.sha256(b"bcd").hexdigest()])

    def test_positive_integer_buffer_preserves_payload_hash(self) -> None:
        payload = b"payload"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "payload.bin"
            path.write_bytes(payload)
            flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            directory_fd = os.open(root, flags)
            try:
                digest = verifier._sha256_payload_at(
                    directory_fd,
                    path.name,
                    path=path,
                    buffer_bytes=2,
                )
            finally:
                os.close(directory_fd)

            self.assertEqual(digest, hashlib.sha256(payload).hexdigest())


if __name__ == "__main__":
    unittest.main()
