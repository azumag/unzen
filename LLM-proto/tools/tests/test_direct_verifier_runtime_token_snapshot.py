from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from direct_verifier_runtime import preflight_direct_verifier_parameters  # noqa: E402


class AmbiguousTruthTokens:
    def __bool__(self) -> bool:
        raise AssertionError("token preflight must not use caller truthiness")

    def __iter__(self):
        yield 4
        yield 5


class SinglePassTokens:
    def __init__(self) -> None:
        self.iterations = 0

    def __iter__(self):
        self.iterations += 1
        if self.iterations > 1:
            raise AssertionError("token input must be snapshotted exactly once")
        yield 7
        yield 8


class DirectVerifierRuntimeTokenSnapshotTest(unittest.TestCase):
    def _preflight(self, token_ids: object, *, token_field: str = "inputTokenIds"):
        return preflight_direct_verifier_parameters(
            token_ids,
            token_field=token_field,
            provider="CPUExecutionProvider",
            kv_heads=4,
            head_size=8,
            atol=1e-4,
            rtol=1e-3,
        )

    def test_numpy_tokens_do_not_use_array_truthiness(self) -> None:
        result = self._preflight(np.array([1, 2, 3], dtype=np.int64))
        self.assertEqual(result[0], [1, 2, 3])

    def test_custom_ambiguous_truth_tokens_are_snapshotted(self) -> None:
        result = self._preflight(AmbiguousTruthTokens())
        self.assertEqual(result[0], [4, 5])

    def test_one_shot_token_input_is_iterated_once(self) -> None:
        tokens = SinglePassTokens()
        result = self._preflight(tokens)
        self.assertEqual(result[0], [7, 8])
        self.assertEqual(tokens.iterations, 1)

    def test_text_and_scalar_inputs_fail_with_stable_boundary_error(self) -> None:
        for malformed in ("123", b"123", bytearray(b"123"), 123, None):
            with self.subTest(malformed=malformed):
                with self.assertRaisesRegex(
                    ValueError,
                    "inputTokenIds must be an iterable of token IDs",
                ):
                    self._preflight(malformed)

    def test_empty_diagnostics_remain_compatible(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least one token ID is required"):
            self._preflight([])
        with self.assertRaisesRegex(ValueError, "at least one prompt token ID is required"):
            self._preflight([], token_field="promptTokenIds")

    def test_element_normalization_and_rejection_are_preserved(self) -> None:
        result = self._preflight(np.array([np.int64(9), np.int64(10)]))
        self.assertEqual(result[0], [9, 10])

        for malformed in ([True], [-1], [1.5], ["1"]):
            with self.subTest(malformed=malformed):
                with self.assertRaisesRegex(
                    ValueError,
                    r"inputTokenIds\[0\] must be a non-negative integer",
                ):
                    self._preflight(malformed)


if __name__ == "__main__":
    unittest.main()
