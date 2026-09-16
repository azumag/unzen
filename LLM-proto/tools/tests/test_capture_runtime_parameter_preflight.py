from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import capture_multi_segment_evidence_run as capture_module  # noqa: E402


class CaptureRuntimeParameterPreflightTest(unittest.TestCase):
    def _assert_rejected_before_capture_side_effects(
        self,
        *,
        token_ids: object = (11,),
        provider: object = "CPUExecutionProvider",
        **kwargs: object,
    ) -> None:
        with (
            patch.object(capture_module, "ensure_destination_available") as destination,
            patch.object(capture_module, "sha256_file") as source_hash,
            patch.object(capture_module, "_make_staging_dir") as staging,
            patch.object(capture_module, "prepare_budgeted_multi_split") as prepare,
        ):
            with self.assertRaises((ValueError, TypeError)):
                capture_module.capture_run(
                    Path("missing.onnx"),
                    Path("capture"),
                    token_ids,  # type: ignore[arg-type]
                    provider=provider,  # type: ignore[arg-type]
                    **kwargs,
                )

        destination.assert_not_called()
        source_hash.assert_not_called()
        staging.assert_not_called()
        prepare.assert_not_called()

    def test_malformed_numerical_parameters_fail_before_capture_side_effects(self) -> None:
        cases = (
            {"token_ids": ()},
            {"kv_heads": 0},
            {"head_size": True},
            {"atol": float("nan")},
            {"rtol": -1.0},
        )
        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                self._assert_rejected_before_capture_side_effects(**kwargs)

    def test_unavailable_provider_fails_before_source_hash_or_generation(self) -> None:
        with (
            patch.object(
                capture_module,
                "ensure_provider_available",
                side_effect=ValueError("provider unavailable"),
            ) as provider_check,
            patch.object(
                capture_module,
                "ensure_destination_available",
                return_value=Path("capture"),
            ) as destination,
            patch.object(capture_module, "sha256_file") as source_hash,
            patch.object(capture_module, "_make_staging_dir") as staging,
            patch.object(capture_module, "prepare_budgeted_multi_split") as prepare,
        ):
            with self.assertRaisesRegex(ValueError, "provider unavailable"):
                capture_module.capture_run(
                    Path("missing.onnx"),
                    Path("capture"),
                    [11],
                    provider="MissingExecutionProvider",
                )

        provider_check.assert_called_once_with("MissingExecutionProvider")
        destination.assert_called_once_with(Path("capture"))
        source_hash.assert_not_called()
        staging.assert_not_called()
        prepare.assert_not_called()

    def test_malformed_budget_parameters_fail_before_source_hash_or_generation(self) -> None:
        cases = (
            {"hidden_size": True},
            {"target_bytes": 0},
            {"preferred_max_bytes": capture_module.PREFERRED_MAX_BYTES + 1},
        )
        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                self._assert_rejected_before_capture_side_effects(**kwargs)

    def test_preflight_normalizes_numerical_parameters_before_destination_check(self) -> None:
        class IndexLike:
            def __init__(self, value: int) -> None:
                self.value = value

            def __index__(self) -> int:
                return self.value

        class DestinationReached(RuntimeError):
            pass

        with (
            patch.object(
                capture_module,
                "ensure_destination_available",
                side_effect=DestinationReached,
            ) as destination,
            patch.object(
                capture_module,
                "validate_run_parameters",
                wraps=capture_module.validate_run_parameters,
            ) as validate,
            patch.object(capture_module, "ensure_provider_available") as provider_check,
            patch.object(capture_module, "sha256_file") as source_hash,
            patch.object(capture_module, "prepare_budgeted_multi_split") as prepare,
        ):
            with self.assertRaises(DestinationReached):
                capture_module.capture_run(
                    Path("missing.onnx"),
                    Path("capture"),
                    [IndexLike(11), IndexLike(22)],  # type: ignore[list-item]
                    kv_heads=IndexLike(8),  # type: ignore[arg-type]
                    head_size=IndexLike(64),  # type: ignore[arg-type]
                    atol="0.0001",  # type: ignore[arg-type]
                    rtol="0.0002",  # type: ignore[arg-type]
                )

        validate.assert_called_once()
        destination.assert_called_once_with(Path("capture"))
        provider_check.assert_not_called()
        source_hash.assert_not_called()
        prepare.assert_not_called()


if __name__ == "__main__":
    unittest.main()
