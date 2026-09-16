from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import multi_segment_onnx as multi  # noqa: E402


class MultiSegmentBudgetOptionRuntimeTest(unittest.TestCase):
    def test_rejects_non_integer_runtime_values(self) -> None:
        defaults: dict[str, object] = {
            "hidden_size": 2048,
            "target_bytes": 1,
            "preferred_max_bytes": 1,
        }
        malformed = (True, 1.5, "1", None, object())

        for name in defaults:
            for value in malformed:
                with self.subTest(name=name, value=repr(value)):
                    options = dict(defaults)
                    options[name] = value
                    with self.assertRaisesRegex(
                        ValueError,
                        rf"{name} must be a positive integer",
                    ):
                        multi._validate_budget_options(**options)  # type: ignore[arg-type]

    def test_rejects_non_positive_integers_with_same_contract(self) -> None:
        for name in ("hidden_size", "target_bytes", "preferred_max_bytes"):
            for value in (0, -1):
                with self.subTest(name=name, value=value):
                    options = {
                        "hidden_size": 2048,
                        "target_bytes": 1,
                        "preferred_max_bytes": 1,
                    }
                    options[name] = value
                    with self.assertRaisesRegex(
                        ValueError,
                        rf"{name} must be a positive integer",
                    ):
                        multi._validate_budget_options(**options)

    def test_valid_integer_policy_is_preserved(self) -> None:
        multi._validate_budget_options(
            hidden_size=2048,
            target_bytes=1,
            preferred_max_bytes=1,
        )

    def test_invalid_options_fail_before_source_or_output_side_effects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "split"
            with mock.patch.object(multi, "_read_source_graph_snapshot") as read_source:
                with self.assertRaisesRegex(
                    ValueError,
                    "hidden_size must be a positive integer",
                ):
                    multi.prepare_budgeted_multi_split(
                        root / "missing.onnx",
                        output,
                        hidden_size=True,  # type: ignore[arg-type]
                        target_bytes=1,
                        preferred_max_bytes=1,
                    )

            read_source.assert_not_called()
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
