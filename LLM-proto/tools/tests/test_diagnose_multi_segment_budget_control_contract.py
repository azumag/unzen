from __future__ import annotations

import hashlib
from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import diagnose_multi_segment_budget as diagnostic  # noqa: E402


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

INVALID_NON_NEGATIVE_INTS = (
    True,
    False,
    0.0,
    1.0,
    1.5,
    float("nan"),
    float("inf"),
    float("-inf"),
    -1,
)


class DiagnoseMultiSegmentBudgetControlContractTest(unittest.TestCase):
    def test_positive_integer_controls_fail_before_source_work(self) -> None:
        defaults: dict[str, object] = {
            "hidden_size": 16,
            "target_bytes": 1,
            "top_initializers": 0,
        }
        for field in ("hidden_size", "target_bytes"):
            for value in INVALID_POSITIVE_INTS:
                with self.subTest(field=field, value=value):
                    arguments = dict(defaults)
                    arguments[field] = value
                    with mock.patch.object(
                        diagnostic,
                        "_read_source_graph_snapshot",
                        side_effect=AssertionError("source work must not run"),
                    ) as read_mock:
                        with self.assertRaisesRegex(
                            ValueError, rf"{field} must be a positive integer"
                        ):
                            diagnostic.diagnose_model(
                                Path("unused.onnx"),
                                **arguments,  # type: ignore[arg-type]
                            )
                        read_mock.assert_not_called()

    def test_top_initializers_requires_exact_non_negative_integer_before_source_work(self) -> None:
        for value in INVALID_NON_NEGATIVE_INTS:
            with self.subTest(value=value):
                with mock.patch.object(
                    diagnostic,
                    "_read_source_graph_snapshot",
                    side_effect=AssertionError("source work must not run"),
                ) as read_mock:
                    with self.assertRaisesRegex(
                        ValueError,
                        "top_initializers must be a non-negative integer",
                    ):
                        diagnostic.diagnose_model(
                            Path("unused.onnx"),
                            hidden_size=16,
                            target_bytes=1,
                            top_initializers=value,  # type: ignore[arg-type]
                        )
                    read_mock.assert_not_called()

    def test_zero_top_initializers_and_positive_integer_controls_preserve_report_path(self) -> None:
        graph = b"graph"
        source = Path("model.onnx")
        costs = {(0, 1): 1}
        with mock.patch.object(
            diagnostic,
            "_read_source_graph_snapshot",
            return_value=(source, graph, hashlib.sha256(graph).hexdigest()),
        ) as read_mock, mock.patch.object(
            diagnostic.onnx, "load_model", return_value=object()
        ), mock.patch.object(
            diagnostic, "discover_total_layers", return_value=1
        ), mock.patch.object(
            diagnostic, "_span_costs", return_value=costs
        ), mock.patch.object(
            diagnostic, "_initializer_rows", return_value=[]
        ) as rows_mock, mock.patch.object(
            diagnostic,
            "_endpoint_isolation_report",
            return_value={"available": False, "decisionStatus": "diagnostic-only"},
        ) as endpoint_mock:
            report = diagnostic.diagnose_model(
                Path("unused.onnx"),
                hidden_size=16,
                target_bytes=1,
                top_initializers=0,
            )

        read_mock.assert_called_once()
        self.assertEqual(report["hiddenSize"], 16)
        self.assertEqual(report["targetBytes"], 1)
        self.assertTrue(report["hardPolicyFeasible"])
        rows_mock.assert_called_once()
        self.assertEqual(rows_mock.call_args.kwargs["limit"], 0)
        self.assertEqual(endpoint_mock.call_args.kwargs["top_initializers"], 0)


if __name__ == "__main__":
    unittest.main()
