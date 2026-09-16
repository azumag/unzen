from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import collect_multi_segment_evidence as evidence_module  # noqa: E402


class ProviderNamePreflightTest(unittest.TestCase):
    def test_rejects_malformed_provider_before_ort_query(self) -> None:
        malformed = (None, False, 0, 1, [], {}, object(), "", "   ", "\t\n")

        for provider in malformed:
            with self.subTest(provider=provider):
                with patch.object(
                    evidence_module.ort,
                    "get_available_providers",
                    side_effect=AssertionError("ORT provider query must not run"),
                ) as provider_query:
                    with self.assertRaisesRegex(
                        ValueError,
                        "provider must be a non-empty ONNX Runtime provider name",
                    ):
                        evidence_module.ensure_provider_available(provider)  # type: ignore[arg-type]

                provider_query.assert_not_called()

    def test_valid_but_unavailable_provider_keeps_existing_error_contract(self) -> None:
        with patch.object(
            evidence_module.ort,
            "get_available_providers",
            return_value=["CPUExecutionProvider"],
        ) as provider_query:
            with self.assertRaisesRegex(
                ValueError,
                "CUDAExecutionProvider.*unavailable",
            ):
                evidence_module.ensure_provider_available("CUDAExecutionProvider")

        provider_query.assert_called_once_with()

    def test_collect_evidence_rejects_malformed_provider_before_numerical_verifier(self) -> None:
        with (
            patch.object(
                evidence_module.ort,
                "get_available_providers",
                side_effect=AssertionError("ORT provider query must not run"),
            ) as provider_query,
            patch.object(evidence_module, "verify_multi_split") as verify,
        ):
            with self.assertRaisesRegex(
                ValueError,
                "provider must be a non-empty ONNX Runtime provider name",
            ):
                evidence_module.collect_evidence(
                    Path("full.onnx"),
                    Path("split-manifest.json"),
                    [1, 2, 3],
                    provider="  ",
                )

        provider_query.assert_not_called()
        verify.assert_not_called()


if __name__ == "__main__":
    unittest.main()
