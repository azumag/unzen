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

    def test_collects_parameters_runtime_and_verification_digest(self) -> None:
        verification = {
            "schemaVersion": "1.1.0",
            "kind": "unzen-budgeted-multi-segment-same-machine-verification",
            "status": "pass",
            "artifactIntegrity": {"manifestSha256": "a" * 64},
            "comparison": {"matches": True},
        }
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

    def test_rejects_unknown_verifier_status(self) -> None:
        with (
            patch.object(
                evidence_module.ort,
                "get_available_providers",
                return_value=["CPUExecutionProvider"],
            ),
            patch.object(
                evidence_module,
                "verify_multi_split",
                return_value={"status": "partial"},
            ),
        ):
            with self.assertRaisesRegex(ValueError, "unsupported status"):
                evidence_module.collect_evidence(
                    Path("full.onnx"),
                    Path("split-manifest.json"),
                    [1],
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
                return_value={"status": "pass"},
            ),
        ):
            with self.assertRaisesRegex(ValueError, "timezone-aware"):
                evidence_module.collect_evidence(
                    Path("full.onnx"),
                    Path("split-manifest.json"),
                    [1],
                    created_at=datetime(2026, 9, 5, 12, 0, 0),
                )


if __name__ == "__main__":
    unittest.main()
