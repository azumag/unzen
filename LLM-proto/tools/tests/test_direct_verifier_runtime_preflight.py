from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_kv_decode as kv_verifier  # noqa: E402
import verify_multi_segment_onnx as logits_verifier  # noqa: E402


class DirectVerifierRuntimePreflightTest(unittest.TestCase):
    def _assert_logits_rejects_before_artifacts(self, **overrides: object) -> None:
        kwargs: dict[str, object] = {
            "provider": "CPUExecutionProvider",
            "kv_heads": 8,
            "head_size": 64,
            "atol": 1e-4,
            "rtol": 1e-4,
        }
        token_ids = overrides.pop("token_ids", [1, 2])
        kwargs.update(overrides)
        with (
            patch.object(logits_verifier, "verify_artifact_snapshot") as artifact_check,
            patch.object(logits_verifier.ort, "InferenceSession") as session,
        ):
            with self.assertRaises(ValueError):
                logits_verifier.verify_multi_split(
                    Path("full.onnx"),
                    Path("split-manifest.json"),
                    token_ids,  # type: ignore[arg-type]
                    **kwargs,  # type: ignore[arg-type]
                )
        artifact_check.assert_not_called()
        session.assert_not_called()

    def _assert_kv_rejects_before_artifacts(self, **overrides: object) -> None:
        kwargs: dict[str, object] = {
            "provider": "CPUExecutionProvider",
            "kv_heads": 8,
            "head_size": 64,
            "atol": 1e-4,
            "rtol": 1e-4,
        }
        prompt_token_ids = overrides.pop("prompt_token_ids", [1, 2])
        next_token_id = overrides.pop("next_token_id", 3)
        kwargs.update(overrides)
        with (
            patch.object(kv_verifier, "verify_artifact_snapshot") as artifact_check,
            patch.object(kv_verifier.ort, "InferenceSession") as session,
        ):
            with self.assertRaises(ValueError):
                kv_verifier.verify_multi_segment_kv_decode(
                    Path("full.onnx"),
                    Path("split-manifest.json"),
                    prompt_token_ids,  # type: ignore[arg-type]
                    next_token_id,  # type: ignore[arg-type]
                    **kwargs,  # type: ignore[arg-type]
                )
        artifact_check.assert_not_called()
        session.assert_not_called()

    def test_logits_rejects_malformed_runtime_parameters_before_artifact_work(self) -> None:
        cases = (
            {"token_ids": [True]},
            {"token_ids": [-1]},
            {"token_ids": [1.5]},
            {"provider": None},
            {"provider": "   "},
            {"kv_heads": 0},
            {"kv_heads": True},
            {"head_size": -1},
            {"atol": float("nan")},
            {"atol": -1.0},
            {"rtol": float("inf")},
            {"rtol": True},
        )
        for case in cases:
            with self.subTest(case=case):
                self._assert_logits_rejects_before_artifacts(**case)

    def test_cached_decode_rejects_malformed_runtime_parameters_before_artifact_work(self) -> None:
        cases = (
            {"prompt_token_ids": [False]},
            {"prompt_token_ids": [-1]},
            {"next_token_id": True},
            {"next_token_id": -1},
            {"next_token_id": 1.5},
            {"provider": 1},
            {"provider": "\t\n"},
            {"kv_heads": 0},
            {"head_size": False},
            {"atol": float("-inf")},
            {"rtol": -0.01},
        )
        for case in cases:
            with self.subTest(case=case):
                self._assert_kv_rejects_before_artifacts(**case)

    def test_valid_runtime_parameters_reach_artifact_preflight_without_ort_session(self) -> None:
        for module, invoke in (
            (
                logits_verifier,
                lambda: logits_verifier.verify_multi_split(
                    Path("full.onnx"), Path("split-manifest.json"), [1, 2]
                ),
            ),
            (
                kv_verifier,
                lambda: kv_verifier.verify_multi_segment_kv_decode(
                    Path("full.onnx"), Path("split-manifest.json"), [1, 2], 3
                ),
            ),
        ):
            with self.subTest(module=module.__name__):
                with (
                    patch.object(
                        module,
                        "verify_artifact_snapshot",
                        side_effect=RuntimeError("artifact preflight reached"),
                    ) as artifact_check,
                    patch.object(module.ort, "InferenceSession") as session,
                ):
                    with self.assertRaisesRegex(RuntimeError, "artifact preflight reached"):
                        invoke()
                artifact_check.assert_called_once_with(Path("split-manifest.json"))
                session.assert_not_called()


if __name__ == "__main__":
    unittest.main()
