from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import collect_multi_segment_kv_decode_evidence as evidence_module  # noqa: E402


def _boundary(*, bytes_: int, after: int = 0, before: int = 1, name: str = "hidden_state") -> dict[str, object]:
    return {
        "afterLayer": after,
        "beforeLayer": before,
        "tensors": [
            {
                "name": name,
                "shape": [1, 2, 8],
                "dtype": "float32",
                "bytes": bytes_,
            }
        ],
        "bytes": bytes_,
    }


def _kv_comparison(*, matches: bool = True) -> dict[str, object]:
    tensors = []
    for layer in range(2):
        for kind in ("key", "value"):
            tensors.append(
                {
                    "name": f"present.{layer}.{kind}",
                    "shape": [1, 2, 8],
                    "dtype": "float32",
                    "bytes": 64,
                    "shapeMatch": True,
                    "matches": matches,
                    "maxAbsDiff": 0.0,
                }
            )
    return {
        "matches": matches,
        "tensorCount": len(tensors),
        "bytes": sum(int(item["bytes"]) for item in tensors),
        "tensors": tensors,
    }


def _logits_comparison(*, matches: bool = True) -> dict[str, object]:
    return {
        "matches": matches,
        "shapeMatch": True,
        "fullShape": [1, 1, 8],
        "splitShape": [1, 1, 8],
        "maxAbsDiff": 0.0,
    }


def valid_verification(*, status: str = "pass") -> dict[str, object]:
    matches = status == "pass"
    return {
        "schemaVersion": "1.0.0",
        "kind": "unzen-budgeted-multi-segment-kv-decode-verification",
        "decisionStatus": "diagnostic-only",
        "provider": "CPUExecutionProvider",
        "promptTokenIds": [11, 22],
        "nextTokenId": 33,
        "segmentCount": 2,
        "cutLayers": [1],
        "artifactIntegrity": {
            "schemaVersion": "1.0.0",
            "kind": "unzen-budgeted-multi-segment-artifact-integrity",
            "status": "pass",
            "manifestSha256": "a" * 64,
            "segmentCount": 2,
            "effectiveRequiredMaxBytes": 256,
            "maximumSegmentArtifactBytes": 30,
            "segments": [
                {
                    "index": 0,
                    "path": "segment0.onnx",
                    "graphBytes": 10,
                    "graphSha256": "b" * 64,
                    "externalData": [
                        {"location": "segment0.data", "bytes": 20, "sha256": "c" * 64}
                    ],
                    "externalBytes": 20,
                    "artifactBytes": 30,
                    "tier": "preferred",
                },
                {
                    "index": 1,
                    "path": "segment1.onnx",
                    "graphBytes": 12,
                    "graphSha256": "d" * 64,
                    "externalData": [
                        {"location": "segment1.data", "bytes": 18, "sha256": "e" * 64}
                    ],
                    "externalBytes": 18,
                    "artifactBytes": 30,
                    "tier": "preferred",
                },
            ],
        },
        "sourceModel": {
            "path": "model_q4.onnx",
            "graphBytes": 50,
            "graphSha256": "f" * 64,
            "externalData": [],
            "allExternalDataHashed": True,
        },
        "kvCacheOwnership": "segment-local",
        "coordinatorRelaysKvCache": False,
        "prompt": {
            "logitsComparison": _logits_comparison(matches=matches),
            "kvComparison": _kv_comparison(matches=matches),
            "boundaries": [_boundary(bytes_=64)],
            "boundaryBytes": 64,
            "fullTop1TokenId": 7,
            "splitTop1TokenId": 7 if matches else 8,
        },
        "decode": {
            "logitsComparison": _logits_comparison(matches=matches),
            "kvComparison": _kv_comparison(matches=matches),
            "boundaries": [_boundary(bytes_=32)],
            "boundaryBytes": 32,
            "fullPastCacheBytesConsumed": 256,
            "splitPastCacheBytesConsumed": 256,
            "fullTop1TokenId": 9,
            "splitTop1TokenId": 9 if matches else 10,
        },
        "sequentialSegmentSessionLoading": True,
        "status": status,
    }


class CollectMultiSegmentKvDecodeEvidenceTest(unittest.TestCase):
    def test_collects_runtime_parameters_and_verification_digest(self) -> None:
        verification = valid_verification()
        created_at = datetime(2026, 9, 10, 9, 30, 0, tzinfo=timezone.utc)
        with (
            patch.object(
                evidence_module.ort,
                "get_available_providers",
                return_value=["CPUExecutionProvider", "AzureExecutionProvider"],
            ),
            patch.object(
                evidence_module,
                "verify_multi_segment_kv_decode",
                return_value=verification,
            ) as verify,
        ):
            evidence = evidence_module.collect_evidence(
                Path("model_q4.onnx"),
                Path("split-manifest.json"),
                [11, 22],
                33,
                kv_heads=8,
                head_size=64,
                atol=2e-4,
                rtol=3e-4,
                created_at=created_at,
            )

        verify.assert_called_once_with(
            Path("model_q4.onnx"),
            Path("split-manifest.json"),
            [11, 22],
            33,
            provider="CPUExecutionProvider",
            kv_heads=8,
            head_size=64,
            atol=2e-4,
            rtol=3e-4,
        )
        self.assertEqual(evidence["status"], "pass")
        self.assertEqual(evidence["decisionStatus"], "diagnostic-only")
        self.assertEqual(evidence["createdAt"], "2026-09-10T09:30:00Z")
        self.assertEqual(evidence["parameters"]["promptTokenIds"], [11, 22])
        self.assertEqual(evidence["parameters"]["nextTokenId"], 33)
        self.assertEqual(
            evidence["runtime"]["availableProviders"],
            ["CPUExecutionProvider", "AzureExecutionProvider"],
        )
        expected = hashlib.sha256(evidence_module.canonical_json_bytes(verification)).hexdigest()
        self.assertEqual(evidence["verificationSha256"], expected)

    def test_rejects_invalid_next_token_before_provider_or_verifier(self) -> None:
        with (
            patch.object(evidence_module, "ensure_provider_available") as provider_check,
            patch.object(evidence_module, "verify_multi_segment_kv_decode") as verify,
        ):
            with self.assertRaisesRegex(ValueError, "nextTokenId"):
                evidence_module.collect_evidence(
                    Path("model.onnx"), Path("manifest.json"), [11, 22], -1
                )
        provider_check.assert_not_called()
        verify.assert_not_called()

    def test_rejects_naive_created_at_before_provider_or_verifier(self) -> None:
        with (
            patch.object(evidence_module, "ensure_provider_available") as provider_check,
            patch.object(evidence_module, "verify_multi_segment_kv_decode") as verify,
        ):
            with self.assertRaisesRegex(ValueError, "timezone-aware"):
                evidence_module.collect_evidence(
                    Path("model.onnx"),
                    Path("manifest.json"),
                    [11, 22],
                    33,
                    created_at=datetime(2026, 9, 10, 9, 30, 0),
                )
        provider_check.assert_not_called()
        verify.assert_not_called()

    def test_rejects_unavailable_provider_before_verifier(self) -> None:
        with (
            patch.object(
                evidence_module.ort,
                "get_available_providers",
                return_value=["CPUExecutionProvider"],
            ),
            patch.object(evidence_module, "verify_multi_segment_kv_decode") as verify,
        ):
            with self.assertRaisesRegex(ValueError, "CUDAExecutionProvider.*unavailable"):
                evidence_module.collect_evidence(
                    Path("model.onnx"),
                    Path("manifest.json"),
                    [11, 22],
                    33,
                    provider="CUDAExecutionProvider",
                )
        verify.assert_not_called()

    def test_rejects_tampered_kv_ownership(self) -> None:
        verification = valid_verification()
        verification["coordinatorRelaysKvCache"] = True
        with self.assertRaisesRegex(ValueError, "coordinatorRelaysKvCache=false"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                prompt_token_ids=[11, 22],
                next_token_id=33,
            )

    def test_rejects_incomplete_kv_pair(self) -> None:
        verification = valid_verification()
        prompt = verification["prompt"]
        assert isinstance(prompt, dict)
        comparison = prompt["kvComparison"]
        assert isinstance(comparison, dict)
        tensors = comparison["tensors"]
        assert isinstance(tensors, list)
        removed = tensors.pop()
        comparison["tensorCount"] = len(tensors)
        comparison["bytes"] = int(comparison["bytes"]) - int(removed["bytes"])
        with self.assertRaisesRegex(ValueError, "incomplete key/value layer pairs"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                prompt_token_ids=[11, 22],
                next_token_id=33,
            )

    def test_rejects_non_contiguous_kv_layers(self) -> None:
        verification = valid_verification()
        for step_name in ("prompt", "decode"):
            step = verification[step_name]
            assert isinstance(step, dict)
            comparison = step["kvComparison"]
            assert isinstance(comparison, dict)
            tensors = comparison["tensors"]
            assert isinstance(tensors, list)
            tensors[2]["name"] = "present.2.key"
            tensors[3]["name"] = "present.2.value"
        with self.assertRaisesRegex(ValueError, "contiguous from layer 0"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                prompt_token_ids=[11, 22],
                next_token_id=33,
            )

    def test_rejects_inconsistent_boundary_byte_accounting(self) -> None:
        verification = valid_verification()
        decode = verification["decode"]
        assert isinstance(decode, dict)
        decode["boundaryBytes"] = 31
        with self.assertRaisesRegex(ValueError, "boundaryBytes"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                prompt_token_ids=[11, 22],
                next_token_id=33,
            )

    def test_rejects_prompt_decode_boundary_topology_drift(self) -> None:
        verification = valid_verification()
        decode = verification["decode"]
        assert isinstance(decode, dict)
        decode["boundaries"] = [_boundary(bytes_=32, name="other_hidden_state")]
        with self.assertRaisesRegex(ValueError, "boundary topology must be identical"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                prompt_token_ids=[11, 22],
                next_token_id=33,
            )

    def test_rejects_boundary_topology_that_disagrees_with_cut_layers(self) -> None:
        verification = valid_verification()
        for step_name, bytes_ in (("prompt", 64), ("decode", 32)):
            step = verification[step_name]
            assert isinstance(step, dict)
            step["boundaries"] = [_boundary(bytes_=bytes_, after=1, before=2)]
        with self.assertRaisesRegex(ValueError, "disagrees with cutLayers"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                prompt_token_ids=[11, 22],
                next_token_id=33,
            )

    def test_rejects_pass_without_consumed_cache(self) -> None:
        verification = valid_verification()
        decode = verification["decode"]
        assert isinstance(decode, dict)
        decode["splitPastCacheBytesConsumed"] = 0
        with self.assertRaisesRegex(ValueError, "status contradicts"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                prompt_token_ids=[11, 22],
                next_token_id=33,
            )

    def test_rejects_prompt_decode_kv_identity_drift(self) -> None:
        verification = valid_verification()
        decode = verification["decode"]
        assert isinstance(decode, dict)
        comparison = decode["kvComparison"]
        assert isinstance(comparison, dict)
        tensors = comparison["tensors"]
        assert isinstance(tensors, list)
        for kind in ("key", "value"):
            tensors.append(
                {
                    "name": f"present.2.{kind}",
                    "shape": [1, 2, 8],
                    "dtype": "float32",
                    "bytes": 64,
                    "shapeMatch": True,
                    "matches": True,
                    "maxAbsDiff": 0.0,
                }
            )
        comparison["tensorCount"] = len(tensors)
        comparison["bytes"] = sum(int(item["bytes"]) for item in tensors)
        with self.assertRaisesRegex(ValueError, "prompt/decode KV tensor identities"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                prompt_token_ids=[11, 22],
                next_token_id=33,
            )

    def test_valid_fail_result_can_be_archived(self) -> None:
        verification = valid_verification(status="fail")
        self.assertEqual(
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                prompt_token_ids=[11, 22],
                next_token_id=33,
            ),
            "fail",
        )

    def test_existing_output_is_rejected_before_numerical_work(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            output = Path(raw_dir) / "evidence.json"
            output.write_text("existing", encoding="utf-8")
            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "collect_multi_segment_kv_decode_evidence.py",
                        "--full-model",
                        "model.onnx",
                        "--manifest",
                        "manifest.json",
                        "--input-ids",
                        "11,22",
                        "--next-token-id",
                        "33",
                        "--output",
                        str(output),
                    ],
                ),
                patch.object(evidence_module, "collect_evidence") as collect,
            ):
                with self.assertRaisesRegex(FileExistsError, "already exists"):
                    evidence_module.main()
            collect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
