from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_bundle as bundle  # noqa: E402


class CaptureBundleParameterContractTest(unittest.TestCase):
    @staticmethod
    def _valid() -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
        summary = {
            "hiddenSize": 2048,
            "targetBytes": 200 * 1024 * 1024,
            "preferredMaxBytes": 256 * 1024 * 1024,
            "provider": "CPUExecutionProvider",
            "inputTokenIds": [11, 22],
            "kvHeads": 8,
            "headSize": 64,
            "atol": 1e-4,
            "rtol": 1e-4,
        }
        evidence = {
            "provider": "CPUExecutionProvider",
            "inputTokenIds": [11, 22],
            "kvHeads": 8,
            "headSize": 64,
            "atol": 1e-4,
            "rtol": 1e-4,
        }
        verification = {
            "provider": "CPUExecutionProvider",
            "inputTokenIds": [11, 22],
        }
        return summary, evidence, verification

    def test_accepts_valid_runtime_parameter_contract(self) -> None:
        summary, evidence, verification = self._valid()
        bundle._bind_run_parameters(summary, evidence, verification)

    def test_bool_integer_alias_is_rejected_before_equality_can_accept_it(self) -> None:
        summary, evidence, verification = self._valid()
        summary["kvHeads"] = True
        evidence["kvHeads"] = 1

        with self.assertRaisesRegex(
            ValueError,
            r"run-summary\.parameters\.kvHeads must be a positive integer",
        ):
            bundle._bind_run_parameters(summary, evidence, verification)

    def test_bool_token_alias_is_rejected_before_list_equality_can_accept_it(self) -> None:
        summary, evidence, verification = self._valid()
        summary["inputTokenIds"] = [True]
        evidence["inputTokenIds"] = [1]
        verification["inputTokenIds"] = [1]

        with self.assertRaisesRegex(
            ValueError,
            r"run-summary\.parameters\.inputTokenIds\[0\] must be a non-negative integer",
        ):
            bundle._bind_run_parameters(summary, evidence, verification)

    def test_empty_provider_and_token_array_are_rejected_even_when_layers_agree(self) -> None:
        for field, invalid, message in (
            ("provider", "", "must be a non-empty string"),
            ("inputTokenIds", [], "must be a non-empty array"),
        ):
            with self.subTest(field=field):
                summary, evidence, verification = self._valid()
                summary[field] = invalid
                evidence[field] = invalid
                verification[field] = invalid
                with self.assertRaisesRegex(ValueError, message):
                    bundle._bind_run_parameters(summary, evidence, verification)

    def test_non_finite_or_negative_tolerances_are_rejected(self) -> None:
        for field, invalid in (
            ("atol", float("inf")),
            ("atol", float("nan")),
            ("rtol", float("-inf")),
            ("rtol", -1.0),
            ("rtol", True),
        ):
            with self.subTest(field=field, invalid=invalid):
                summary, evidence, verification = self._valid()
                summary[field] = invalid
                evidence[field] = invalid
                with self.assertRaisesRegex(
                    ValueError,
                    rf"run-summary\.parameters\.{field} must be a finite non-negative number",
                ):
                    bundle._bind_run_parameters(summary, evidence, verification)

    def test_summary_generation_controls_require_positive_integers(self) -> None:
        for field, invalid in (
            ("hiddenSize", True),
            ("hiddenSize", 0),
            ("targetBytes", 1.0),
            ("preferredMaxBytes", -1),
        ):
            with self.subTest(field=field, invalid=invalid):
                summary, evidence, verification = self._valid()
                summary[field] = invalid
                with self.assertRaisesRegex(
                    ValueError,
                    rf"run-summary\.parameters\.{field} must be a positive integer",
                ):
                    bundle._bind_run_parameters(summary, evidence, verification)

    def test_target_bytes_cannot_exceed_preferred_max_bytes(self) -> None:
        summary, evidence, verification = self._valid()
        summary["targetBytes"] = 257
        summary["preferredMaxBytes"] = 256

        with self.assertRaisesRegex(
            ValueError,
            "targetBytes cannot exceed run-summary.parameters.preferredMaxBytes",
        ):
            bundle._bind_run_parameters(summary, evidence, verification)

    def test_mismatch_is_still_rejected_after_semantic_validation(self) -> None:
        summary, evidence, verification = self._valid()
        evidence["headSize"] = 128

        with self.assertRaisesRegex(
            ValueError,
            r"run-summary\.parameters\.headSize vs evidence\.parameters mismatch",
        ):
            bundle._bind_run_parameters(summary, evidence, verification)


if __name__ == "__main__":
    unittest.main()
