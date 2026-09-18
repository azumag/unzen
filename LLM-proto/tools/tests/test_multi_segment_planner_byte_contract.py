from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import multi_segment_onnx as planner  # noqa: E402


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


class MultiSegmentPlannerByteContractTest(unittest.TestCase):
    def test_select_partition_rejects_invalid_controls_before_span_cost(self) -> None:
        defaults: dict[str, object] = {
            "total_layers": 2,
            "target_bytes": 1,
            "required_max_bytes": 2,
        }
        for field in defaults:
            for value in INVALID_POSITIVE_INTS:
                with self.subTest(field=field, value=value):
                    span_cost = mock.Mock(
                        side_effect=AssertionError("span_cost must not run")
                    )
                    arguments = dict(defaults)
                    arguments[field] = value
                    with self.assertRaisesRegex(
                        ValueError, rf"{field} must be a positive integer"
                    ):
                        planner._select_partition(
                            **arguments,  # type: ignore[arg-type]
                            span_cost=span_cost,
                        )
                    span_cost.assert_not_called()

    def test_select_partition_rejects_target_above_ceiling_before_span_cost(self) -> None:
        span_cost = mock.Mock(side_effect=AssertionError("span_cost must not run"))
        with self.assertRaisesRegex(
            ValueError, "target_bytes cannot exceed required_max_bytes"
        ):
            planner._select_partition(
                total_layers=2,
                target_bytes=3,
                required_max_bytes=2,
                span_cost=span_cost,
            )
        span_cost.assert_not_called()

    def test_select_partition_rejects_non_integer_span_costs_without_coercion(self) -> None:
        invalid_costs = (True, False, 1.0, 1.5, "1", float("nan"), -1)
        for value in invalid_costs:
            with self.subTest(span_cost=value):
                with self.assertRaisesRegex(
                    ValueError,
                    r"span cost for \[0, 1\) must be a non-negative integer",
                ):
                    planner._select_partition(
                        total_layers=1,
                        target_bytes=1,
                        required_max_bytes=1,
                        span_cost=lambda _start, _end, value=value: value,  # type: ignore[return-value]
                    )

    def test_plan_layer_spans_rejects_invalid_controls_before_model_discovery(self) -> None:
        defaults: dict[str, object] = {
            "hidden_size": 16,
            "target_bytes": 1,
            "required_max_bytes": 2,
        }
        for field in defaults:
            for value in INVALID_POSITIVE_INTS:
                with self.subTest(field=field, value=value):
                    arguments = dict(defaults)
                    arguments[field] = value
                    with mock.patch.object(
                        planner,
                        "discover_total_layers",
                        side_effect=AssertionError("model must not be inspected"),
                    ) as discover_mock:
                        with self.assertRaisesRegex(
                            ValueError, rf"{field} must be a positive integer"
                        ):
                            planner.plan_layer_spans(
                                mock.Mock(),
                                **arguments,  # type: ignore[arg-type]
                            )
                        discover_mock.assert_not_called()

    def test_plan_layer_spans_rejects_target_above_ceiling_before_model_discovery(self) -> None:
        with mock.patch.object(
            planner,
            "discover_total_layers",
            side_effect=AssertionError("model must not be inspected"),
        ) as discover_mock:
            with self.assertRaisesRegex(
                ValueError, "target_bytes cannot exceed required_max_bytes"
            ):
                planner.plan_layer_spans(
                    mock.Mock(),
                    hidden_size=16,
                    target_bytes=3,
                    required_max_bytes=2,
                )
            discover_mock.assert_not_called()

    def test_zero_and_positive_integer_costs_preserve_valid_plans(self) -> None:
        zero_cuts, zero_costs = planner._select_partition(
            total_layers=2,
            target_bytes=1,
            required_max_bytes=1,
            span_cost=lambda _start, _end: 0,
        )
        self.assertEqual(zero_cuts, ())
        self.assertEqual(zero_costs, (0,))

        cuts, costs = planner._select_partition(
            total_layers=4,
            target_bytes=2,
            required_max_bytes=2,
            span_cost=lambda start, end: end - start,
        )
        self.assertEqual(cuts, (2,))
        self.assertEqual(costs, (2, 2))


if __name__ == "__main__":
    unittest.main()
