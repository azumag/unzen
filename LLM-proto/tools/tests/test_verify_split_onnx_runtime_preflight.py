from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_split_onnx as verifier  # noqa: E402


class VerifySplitOnnxRuntimePreflightTest(unittest.TestCase):
    def _assert_rejected_before_manifest(self, **overrides: object) -> None:
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
            patch.object(verifier, "_load_manifest_snapshot") as manifest_read,
            patch.object(verifier.ort, "InferenceSession") as session,
        ):
            with self.assertRaises(ValueError):
                verifier.verify_split(
                    Path("full.onnx"),
                    Path("segment0.onnx"),
                    Path("segment1.onnx"),
                    Path("split-manifest.json"),
                    token_ids,  # type: ignore[arg-type]
                    **kwargs,  # type: ignore[arg-type]
                )

        manifest_read.assert_not_called()
        session.assert_not_called()

    def test_rejects_malformed_runtime_parameters_before_manifest_or_ort(self) -> None:
        cases = (
            {"token_ids": [True]},
            {"token_ids": [-1]},
            {"token_ids": [1.5]},
            {"provider": None},
            {"provider": "   "},
            {"kv_heads": 0},
            {"kv_heads": True},
            {"head_size": -1},
            {"head_size": False},
            {"atol": float("nan")},
            {"atol": float("inf")},
            {"atol": -1.0},
            {"rtol": float("-inf")},
            {"rtol": True},
        )
        for case in cases:
            with self.subTest(case=case):
                self._assert_rejected_before_manifest(**case)

    def test_valid_runtime_parameters_reach_manifest_before_ort(self) -> None:
        with (
            patch.object(
                verifier,
                "_load_manifest_snapshot",
                side_effect=RuntimeError("manifest preflight reached"),
            ) as manifest_read,
            patch.object(verifier.ort, "InferenceSession") as session,
        ):
            with self.assertRaisesRegex(RuntimeError, "manifest preflight reached"):
                verifier.verify_split(
                    Path("full.onnx"),
                    Path("segment0.onnx"),
                    Path("segment1.onnx"),
                    Path("split-manifest.json"),
                    [1, 2],
                )

        manifest_read.assert_called_once_with(Path("split-manifest.json"))
        session.assert_not_called()

    def test_token_iterable_is_snapshotted_once_before_manifest(self) -> None:
        consumed = 0

        def tokens():
            nonlocal consumed
            for token in (3, 4):
                consumed += 1
                yield token

        @contextmanager
        def source_snapshot(_path: Path, _manifest: dict[str, object]):
            yield ({}, Path("snapshot-full.onnx"))

        manifest = {
            "boundary": {"tensors": []},
            "logitsOutput": "logits",
        }
        with (
            patch.object(verifier, "_load_manifest_snapshot", return_value=manifest),
            patch.object(
                verifier,
                "verified_source_execution_snapshot",
                side_effect=source_snapshot,
            ),
            patch.object(
                verifier.ort,
                "InferenceSession",
                side_effect=RuntimeError("ORT reached"),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "ORT reached"):
                verifier.verify_split(
                    Path("full.onnx"),
                    Path("segment0.onnx"),
                    Path("segment1.onnx"),
                    Path("split-manifest.json"),
                    tokens(),  # type: ignore[arg-type]
                )

        self.assertEqual(consumed, 2)


if __name__ == "__main__":
    unittest.main()
