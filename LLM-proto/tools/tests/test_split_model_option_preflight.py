from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import split_llama_1b_onnx as splitter  # noqa: E402


INVALID_POSITIVE_INTS = (
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


class SplitModelOptionPreflightTest(unittest.TestCase):
    def _assert_no_source_or_output_work(self, **overrides: object) -> None:
        arguments: dict[str, object] = {
            "split_layer": 8,
            "hidden_size": 2048,
            "external_data_mode": "symlink",
            "hash_external_data": True,
        }
        arguments.update(overrides)
        with mock.patch.object(
            splitter,
            "read_regular_file_snapshot",
            side_effect=AssertionError("source read must not run"),
        ) as read_mock, mock.patch.object(
            Path,
            "mkdir",
            side_effect=AssertionError("output mkdir must not run"),
        ) as mkdir_mock:
            splitter.split_model(
                Path("unused.onnx"),
                Path("unused-output"),
                **arguments,  # type: ignore[arg-type]
            )
        read_mock.assert_not_called()
        mkdir_mock.assert_not_called()

    def test_positive_integer_controls_fail_before_source_or_output_work(self) -> None:
        for field in ("split_layer", "hidden_size"):
            for value in INVALID_POSITIVE_INTS:
                with self.subTest(field=field, value=value):
                    with self.assertRaisesRegex(
                        ValueError, rf"{field} must be a positive integer"
                    ):
                        self._assert_no_source_or_output_work(**{field: value})

    def test_invalid_external_data_mode_fails_before_source_or_output_work(self) -> None:
        for value in ("", "hardlink", None, 1, []):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "unsupported external data mode"):
                    self._assert_no_source_or_output_work(external_data_mode=value)

    def test_non_boolean_digest_control_fails_before_source_or_output_work(self) -> None:
        for value in (None, 0, 1, "", "false", [], ()):
            with self.subTest(value=value):
                with self.assertRaisesRegex(
                    ValueError, "hash_external_data must be a boolean"
                ):
                    self._assert_no_source_or_output_work(hash_external_data=value)

    def test_valid_controls_reach_existing_source_snapshot_path(self) -> None:
        for mode in ("symlink", "copy", "none"):
            for hash_external_data in (True, False):
                with self.subTest(
                    mode=mode,
                    hash_external_data=hash_external_data,
                ), mock.patch.object(
                    splitter,
                    "read_regular_file_snapshot",
                    side_effect=RuntimeError("source path reached"),
                ) as read_mock:
                    with self.assertRaisesRegex(RuntimeError, "source path reached"):
                        splitter.split_model(
                            Path("unused.onnx"),
                            Path("unused-output"),
                            split_layer=8,
                            hidden_size=2048,
                            external_data_mode=mode,
                            hash_external_data=hash_external_data,
                        )
                    read_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
