from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import probe_llama_1b_endpoint_preferred_tile_ort_cpu as probe  # noqa: E402


class PreferredTilePayloadExpectationPreflightTests(unittest.TestCase):
    def _assert_rejected_before_filesystem(
        self, *, expected_bytes: object, expected_sha256: object, message: str
    ) -> None:
        path = Path("/must-not-be-touched/payload-0000.bin")
        with mock.patch.object(
            Path,
            "lstat",
            side_effect=AssertionError("lstat must not run for invalid expectations"),
        ) as lstat_mock:
            with mock.patch.object(
                probe.os,
                "open",
                side_effect=AssertionError("os.open must not run for invalid expectations"),
            ) as open_mock:
                with self.assertRaisesRegex(RuntimeError, message):
                    probe._open_pinned_payload(
                        path,
                        expected_bytes=expected_bytes,  # type: ignore[arg-type]
                        expected_sha256=expected_sha256,  # type: ignore[arg-type]
                    )
        lstat_mock.assert_not_called()
        open_mock.assert_not_called()

    def test_invalid_expected_bytes_fail_before_filesystem_access(self) -> None:
        valid_sha256 = "0" * 64
        for value in (True, False, 0, -1, 1.0, "1", None):
            with self.subTest(expected_bytes=value):
                self._assert_rejected_before_filesystem(
                    expected_bytes=value,
                    expected_sha256=valid_sha256,
                    message="expected physical payload byte length must be a positive integer",
                )

    def test_invalid_expected_sha256_fails_before_filesystem_access(self) -> None:
        for value in (
            None,
            b"0" * 64,
            "",
            "0" * 63,
            "0" * 65,
            "g" * 64,
            "A" * 64,
            ("0" * 63) + "A",
        ):
            with self.subTest(expected_sha256=value):
                self._assert_rejected_before_filesystem(
                    expected_bytes=1,
                    expected_sha256=value,
                    message=(
                        "expected physical payload SHA-256 must be 64 lowercase "
                        "hexadecimal characters"
                    ),
                )


if __name__ == "__main__":
    unittest.main()
