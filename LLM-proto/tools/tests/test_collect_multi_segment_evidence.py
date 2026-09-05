from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import collect_multi_segment_evidence as evidence_module  # noqa: E402


def valid_verification(*, status: str = "pass") -> dict[str, object]:
    matches = status == "pass"
    return {
        "schemaVersion": "1.1.0",
        "kind": "unzen-budgeted-multi-segment-same-machine-verification",
        "status": status,
        "provider": "CPUExecutionProvider",
        "inputTokenIds": [11, 22],
        "segmentCount": 2,
        "cutLayers": [15],
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
                    "graphSha256": "d" * 64,
                    "externalData": [
                        {
                            "location": "segment0.onnx_data",
                            "bytes": 20,
                            "sha256": "e" * 64,
                        }
                    ],
                    "externalBytes": 20,
                    "artifactBytes": 30,
                    "tier": "preferred",
                },
                {
                    "index": 1,
                    "path": "segment1.onnx",
                    "graphBytes": 12,
                    "graphSha256": "f" * 64,
                    "externalData": [
                        {
                            "location": "segment1.onnx_data",
                            "bytes": 18,
                            "sha256": "1" * 64,
                        }
                    ],
                    "externalBytes": 18,
                    "artifactBytes": 30,
                    "tier": "preferred",
                },
            ],
        },
        "sourceModel": {
            "path": "full.onnx",
            "graphBytes": 50,
            "graphSha256": "b" * 64,
            "externalData": [
                {
                    "location": "model_q4.onnx_data",
                    "bytes": 123,
                    "sha256": "c" * 64,
                }
            ],
            "allExternalDataHashed": True,
        },
        "boundaries": [
            {
                "afterLayer": 14,
                "beforeLayer": 15,
                "tensors": [
                    {
                        "name": "hidden_state",
                        "shape": [1, 2, 8],
                        "dtype": "float32",
                        "bytes": 64,
                    }
                ],
                "bytes": 64,
            }
        ],
        "boundaryBytes": 64,
        "comparison": {
            "matches": matches,
            "shapeMatch": True,
            "fullShape": [1, 2, 8],
            "splitShape": [1, 2, 8],
            "maxAbsDiff": 0.0,
        },
        "fullTop1TokenId": 7,
        "splitTop1TokenId": 7 if matches else 8,
        "sequentialSessionLoading": True,
    }


class CollectMultiSegmentEvidenceTest(unittest.TestCase):
    def test_rejects_unavailable_provider_before_numerical_verification(self) -> None:
        with (
            patch.object(
                evidence_module.ort,
                "get_available_providers",
                return_value=["CPUExecutionProvider"],
            ),
            patch.object(evidence_module, "verify_multi_split") as verify,
        ):
            with self.assertRaisesRegex(ValueError, "CUDAExecutionProvider.*unavailable"):
                evidence_module.collect_evidence(
                    Path("full.onnx"),
                    Path("split-manifest.json"),
                    [1, 2, 3],
                    provider="CUDAExecutionProvider",
                )

        verify.assert_not_called()

    def test_rejects_invalid_run_parameters_before_provider_or_numerical_work(self) -> None:
        cases = (
            ({"token_ids": [11, -1]}, "inputTokenIds\\[1\\]"),
            ({"token_ids": [11, 22], "kv_heads": 0}, "kvHeads"),
            ({"token_ids": [11, 22], "head_size": 0}, "headSize"),
            ({"token_ids": [11, 22], "atol": float("nan")}, "atol"),
            ({"token_ids": [11, 22], "rtol": -1.0}, "rtol"),
        )
        for raw_kwargs, message in cases:
            kwargs = dict(raw_kwargs)
            token_ids = kwargs.pop("token_ids")
            with self.subTest(raw_kwargs=raw_kwargs):
                with (
                    patch.object(
                        evidence_module, "ensure_provider_available"
                    ) as provider_check,
                    patch.object(evidence_module, "verify_multi_split") as verify,
                ):
                    with self.assertRaisesRegex(ValueError, message):
                        evidence_module.collect_evidence(
                            Path("full.onnx"),
                            Path("split-manifest.json"),
                            token_ids,
                            **kwargs,
                        )
                provider_check.assert_not_called()
                verify.assert_not_called()

    def test_collects_parameters_runtime_and_verification_digest(self) -> None:
        verification = valid_verification()
        created_at = datetime(2026, 9, 5, 12, 34, 56, tzinfo=timezone.utc)

        with (
            patch.object(
                evidence_module.ort,
                "get_available_providers",
                return_value=["CPUExecutionProvider", "AzureExecutionProvider"],
            ),
            patch.object(
                evidence_module,
                "verify_multi_split",
                return_value=verification,
            ) as verify,
        ):
            evidence = evidence_module.collect_evidence(
                Path("full.onnx"),
                Path("split-manifest.json"),
                [11, 22],
                provider="CPUExecutionProvider",
                kv_heads=8,
                head_size=64,
                atol=2e-4,
                rtol=3e-4,
                created_at=created_at,
            )

        verify.assert_called_once_with(
            Path("full.onnx"),
            Path("split-manifest.json"),
            [11, 22],
            provider="CPUExecutionProvider",
            kv_heads=8,
            head_size=64,
            atol=2e-4,
            rtol=3e-4,
        )
        self.assertEqual(evidence["status"], "pass")
        self.assertEqual(evidence["createdAt"], "2026-09-05T12:34:56Z")
        self.assertEqual(
            evidence["parameters"],
            {
                "provider": "CPUExecutionProvider",
                "inputTokenIds": [11, 22],
                "kvHeads": 8,
                "headSize": 64,
                "atol": 2e-4,
                "rtol": 3e-4,
            },
        )
        runtime = evidence["runtime"]
        self.assertEqual(runtime["requestedProvider"], "CPUExecutionProvider")
        self.assertEqual(
            runtime["availableProviders"],
            ["CPUExecutionProvider", "AzureExecutionProvider"],
        )
        self.assertTrue(runtime["pythonVersion"])
        self.assertTrue(runtime["numpyVersion"])
        self.assertTrue(runtime["onnxruntimeVersion"])
        expected_digest = hashlib.sha256(
            evidence_module.canonical_json_bytes(verification)
        ).hexdigest()
        self.assertEqual(evidence["verificationSha256"], expected_digest)
        self.assertIs(evidence["verification"], verification)

    def test_rejects_verifier_report_without_identity_binding(self) -> None:
        verification = valid_verification()
        verification.pop("sourceModel")
        with (
            patch.object(
                evidence_module.ort,
                "get_available_providers",
                return_value=["CPUExecutionProvider"],
            ),
            patch.object(
                evidence_module,
                "verify_multi_split",
                return_value=verification,
            ),
        ):
            with self.assertRaisesRegex(ValueError, "sourceModel must be an object"):
                evidence_module.collect_evidence(
                    Path("full.onnx"),
                    Path("split-manifest.json"),
                    [11, 22],
                )

    def test_rejects_verifier_report_with_mismatched_provider_or_tokens(self) -> None:
        verification = valid_verification()
        verification["provider"] = "AzureExecutionProvider"
        with self.assertRaisesRegex(ValueError, "provider mismatch"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                token_ids=[11, 22],
            )

        verification = valid_verification()
        verification["inputTokenIds"] = [11, 23]
        with self.assertRaisesRegex(ValueError, "token IDs mismatch"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                token_ids=[11, 22],
            )

    def test_rejects_incomplete_artifact_integrity_contract(self) -> None:
        verification = valid_verification()
        verification["artifactIntegrity"]["segments"][1]["graphSha256"] = ""
        with self.assertRaisesRegex(ValueError, "graphSha256"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                token_ids=[11, 22],
            )

    def test_rejects_inconsistent_boundary_measurements(self) -> None:
        verification = valid_verification()
        verification["boundaries"][0]["bytes"] = 63
        with self.assertRaisesRegex(ValueError, "does not match tensor byte sum"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                token_ids=[11, 22],
            )

    def test_rejects_status_that_contradicts_comparison_and_top1(self) -> None:
        verification = valid_verification()
        verification["status"] = "fail"
        with self.assertRaisesRegex(ValueError, "status contradicts"):
            evidence_module.validate_verification_binding(
                verification,
                provider="CPUExecutionProvider",
                token_ids=[11, 22],
            )

    def test_rejects_unknown_verifier_status(self) -> None:
        verification = valid_verification()
        verification["status"] = "partial"
        with (
            patch.object(
                evidence_module.ort,
                "get_available_providers",
                return_value=["CPUExecutionProvider"],
            ),
            patch.object(
                evidence_module,
                "verify_multi_split",
                return_value=verification,
            ),
        ):
            with self.assertRaisesRegex(ValueError, "unsupported status"):
                evidence_module.collect_evidence(
                    Path("full.onnx"),
                    Path("split-manifest.json"),
                    [11, 22],
                )

    def test_write_evidence_is_no_clobber_and_returns_file_digest(self) -> None:
        payload = {"kind": "test", "status": "pass", "value": "証拠"}
        with tempfile.TemporaryDirectory() as raw_dir:
            output = Path(raw_dir) / "nested" / "evidence.json"
            digest = evidence_module.write_evidence(output, payload)

            encoded = output.read_bytes()
            self.assertEqual(digest, hashlib.sha256(encoded).hexdigest())
            self.assertEqual(json.loads(encoded.decode("utf-8")), payload)

            with self.assertRaises(FileExistsError):
                evidence_module.write_evidence(output, {"status": "fail"})
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), payload)
            self.assertEqual(list(output.parent.glob(".*.tmp")), [])

    def test_existing_output_is_rejected_before_numerical_work(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            output = Path(raw_dir) / "evidence.json"
            output.write_text("existing", encoding="utf-8")
            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "collect_multi_segment_evidence.py",
                        "--full-model",
                        "full.onnx",
                        "--manifest",
                        "split-manifest.json",
                        "--input-ids",
                        "11,22",
                        "--output",
                        str(output),
                    ],
                ),
                patch.object(evidence_module, "collect_evidence") as collect,
            ):
                with self.assertRaisesRegex(FileExistsError, "already exists"):
                    evidence_module.main()
            collect.assert_not_called()

    def test_created_at_must_be_timezone_aware(self) -> None:
        with (
            patch.object(
                evidence_module.ort,
                "get_available_providers",
                return_value=["CPUExecutionProvider"],
            ),
            patch.object(
                evidence_module,
                "verify_multi_split",
                return_value=valid_verification(),
            ),
        ):
            with self.assertRaisesRegex(ValueError, "timezone-aware"):
                evidence_module.collect_evidence(
                    Path("full.onnx"),
                    Path("split-manifest.json"),
                    [11, 22],
                    created_at=datetime(2026, 9, 5, 12, 0, 0),
                )


if __name__ == "__main__":
    unittest.main()
