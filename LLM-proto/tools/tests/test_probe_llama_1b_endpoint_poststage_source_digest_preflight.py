from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import probe_llama_1b_endpoint_poststage_tiled_ort_cpu as probe  # noqa: E402


class PoststageSourceDigestPreflightTests(unittest.TestCase):
    def test_invalid_source_graph_digest_fails_before_filesystem_access(self) -> None:
        path = Path("/must-not-be-touched/source.onnx")
        invalid_values = (
            None,
            b"0" * 64,
            "",
            "0" * 63,
            "0" * 65,
            "g" * 64,
            "A" * 64,
            ("0" * 63) + "A",
        )

        for value in invalid_values:
            with self.subTest(expected_sha256=value):
                with mock.patch.object(
                    Path,
                    "lstat",
                    side_effect=AssertionError("lstat must not run for an invalid digest"),
                ) as lstat_mock:
                    with mock.patch.object(
                        probe.preferred_probe,
                        "_open_pinned_payload",
                        side_effect=AssertionError(
                            "shared payload opener must not run for an invalid digest"
                        ),
                    ) as open_mock:
                        with self.assertRaisesRegex(
                            RuntimeError,
                            "upstream layout source graph SHA-256 is invalid",
                        ):
                            probe._load_pinned_source_model(
                                path,
                                expected_sha256=value,  # type: ignore[arg-type]
                            )
                lstat_mock.assert_not_called()
                open_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
