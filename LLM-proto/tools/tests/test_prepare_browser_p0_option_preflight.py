from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_browser_p0 as p0  # noqa: E402


class PrepareBrowserP0OptionPreflightTest(unittest.TestCase):
    def test_invalid_required_tier_fails_before_source_or_split_work(self) -> None:
        with mock.patch.object(
            p0,
            "verify_pinned_source_graph",
            side_effect=AssertionError("source verification must not run"),
        ) as verify_mock, mock.patch.object(
            p0,
            "prepare_real_split",
            side_effect=AssertionError("split generation must not run"),
        ) as split_mock:
            with self.assertRaisesRegex(ValueError, "unsupported required tier"):
                p0.prepare_browser_p0(
                    Path("unused.onnx"),
                    Path("unused-output"),
                    require_tier="future",
                )

        verify_mock.assert_not_called()
        split_mock.assert_not_called()

    def test_non_boolean_digest_control_fails_before_source_or_split_work(self) -> None:
        invalid_values = (None, 0, 1, "", "false", [], ())
        for value in invalid_values:
            with self.subTest(value=value), mock.patch.object(
                p0,
                "verify_pinned_source_graph",
                side_effect=AssertionError("source verification must not run"),
            ) as verify_mock, mock.patch.object(
                p0,
                "prepare_real_split",
                side_effect=AssertionError("split generation must not run"),
            ) as split_mock:
                with self.assertRaisesRegex(
                    ValueError, "hash_source_external_data must be a boolean"
                ):
                    p0.prepare_browser_p0(
                        Path("unused.onnx"),
                        Path("unused-output"),
                        hash_source_external_data=value,  # type: ignore[arg-type]
                    )

                verify_mock.assert_not_called()
                split_mock.assert_not_called()

    def test_supported_tiers_and_literal_booleans_reach_existing_source_path(self) -> None:
        for tier in p0.TIER_LIMITS:
            for hash_source_external_data in (True, False):
                with self.subTest(
                    tier=tier,
                    hash_source_external_data=hash_source_external_data,
                ), mock.patch.object(
                    p0,
                    "verify_pinned_source_graph",
                    side_effect=RuntimeError("source path reached"),
                ) as verify_mock:
                    with self.assertRaisesRegex(RuntimeError, "source path reached"):
                        p0.prepare_browser_p0(
                            Path("unused.onnx"),
                            Path("unused-output"),
                            require_tier=tier,
                            hash_source_external_data=hash_source_external_data,
                        )
                    verify_mock.assert_called_once_with(Path("unused.onnx"))


if __name__ == "__main__":
    unittest.main()
