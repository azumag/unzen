from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_kv_decode_evidence as verifier  # noqa: E402
from test_collect_multi_segment_kv_decode_evidence import valid_verification  # noqa: E402


def valid_evidence(*, verification_status: str = "pass", evidence_status: str | None = None) -> dict[str, object]:
    verification = valid_verification(status=verification_status)
    digest = hashlib.sha256(verifier.canonical_json_bytes(verification)).hexdigest()
    return {
        "schemaVersion": "1.0.0",
        "kind": "unzen-budgeted-multi-segment-kv-decode-evidence-bundle",
        "createdAt": "2026-09-10T11:55:00Z",
        "status": evidence_status or verification_status,
        "decisionStatus": "diagnostic-only",
        "parameters": {
            "provider": "CPUExecutionProvider",
            "promptTokenIds": [11, 22],
            "nextTokenId": 33,
            "kvHeads": 8,
            "headSize": 64,
            "atol": 0.0001,
            "rtol": 0.0001,
        },
        "runtime": {
            "pythonVersion": "3.12.11",
            "platform": "Linux-test",
            "numpyVersion": "2.0.0",
            "onnxruntimeVersion": "1.22.0",
            "requestedProvider": "CPUExecutionProvider",
            "availableProviders": ["CPUExecutionProvider", "AzureExecutionProvider"],
        },
        "verificationSha256": digest,
        "verification": verification,
    }


def rewrite_digest(evidence: dict[str, object]) -> None:
    verification = evidence["verification"]
    assert isinstance(verification, dict)
    evidence["verificationSha256"] = hashlib.sha256(
        verifier.canonical_json_bytes(verification)
    ).hexdigest()


class VerifyMultiSegmentKvDecodeEvidenceTest(unittest.TestCase):
    def test_accepts_self_consistent_passing_bundle(self) -> None:
        summary = verifier.verify_evidence(valid_evidence())
        self.assertTrue(summary["verified"])
        self.assertEqual(summary["evidenceStatus"], "pass")
        self.assertEqual(summary["provider"], "CPUExecutionProvider")
        self.assertEqual(summary["promptTokenCount"], 2)
        self.assertEqual(summary["nextTokenId"], 33)
        self.assertEqual(summary["segmentCount"], 2)

    def test_accepts_self_consistent_failing_measurement(self) -> None:
        summary = verifier.verify_evidence(valid_evidence(verification_status="fail"))
        self.assertTrue(summary["verified"])
        self.assertEqual(summary["evidenceStatus"], "fail")

    def test_rejects_embedded_verification_digest_tampering(self) -> None:
        evidence = valid_evidence()
        verification = evidence["verification"]
        assert isinstance(verification, dict)
        verification["nextTokenId"] = 34
        with self.assertRaisesRegex(ValueError, "verificationSha256 does not match"):
            verifier.verify_evidence(evidence)

    def test_rejects_semantic_tampering_even_with_recomputed_digest(self) -> None:
        evidence = valid_evidence()
        verification = evidence["verification"]
        assert isinstance(verification, dict)
        decode = verification["decode"]
        assert isinstance(decode, dict)
        decode["splitPastCacheBytesConsumed"] = 128
        rewrite_digest(evidence)
        with self.assertRaisesRegex(ValueError, "must equal prompt KV bytes"):
            verifier.verify_evidence(evidence)

    def test_rejects_parameter_tampering_even_with_untouched_verification_digest(self) -> None:
        evidence = valid_evidence()
        parameters = evidence["parameters"]
        assert isinstance(parameters, dict)
        parameters["nextTokenId"] = 34
        with self.assertRaisesRegex(ValueError, "next token ID mismatch"):
            verifier.verify_evidence(evidence)

    def test_rejects_runtime_provider_that_disagrees_with_parameters(self) -> None:
        evidence = valid_evidence()
        runtime = evidence["runtime"]
        assert isinstance(runtime, dict)
        runtime["requestedProvider"] = "CUDAExecutionProvider"
        with self.assertRaisesRegex(ValueError, "requestedProvider"):
            verifier.verify_evidence(evidence)

    def test_rejects_evidence_status_that_disagrees_with_verification(self) -> None:
        evidence = valid_evidence(verification_status="fail", evidence_status="pass")
        with self.assertRaisesRegex(ValueError, "evidence status disagrees"):
            verifier.verify_evidence(evidence)

    def test_rejects_non_utc_created_at(self) -> None:
        evidence = valid_evidence()
        evidence["createdAt"] = "2026-09-10T20:55:00+09:00"
        with self.assertRaisesRegex(ValueError, "ending in Z"):
            verifier.verify_evidence(evidence)

    def test_file_reader_rejects_symlink(self) -> None:
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks are unavailable")
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            target = root / "target.json"
            target.write_text(json.dumps(valid_evidence()), encoding="utf-8")
            link = root / "evidence.json"
            try:
                link.symlink_to(target)
            except (NotImplementedError, OSError) as error:
                self.skipTest(f"symlinks unavailable: {error}")
            with self.assertRaisesRegex(ValueError, "must not be a symlink"):
                verifier.verify_evidence_file(link)

    def test_file_reader_enforces_configured_size_limit(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "evidence.json"
            path.write_text(json.dumps(valid_evidence()), encoding="utf-8")
            with patch.dict(os.environ, {verifier.MAX_BYTES_ENV: "32"}):
                with self.assertRaisesRegex(ValueError, "exceeds 32 bytes"):
                    verifier.verify_evidence_file(path)

    def test_file_reader_rejects_invalid_utf8(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "evidence.json"
            path.write_bytes(b"{\xff}")
            with self.assertRaisesRegex(ValueError, "valid UTF-8"):
                verifier.verify_evidence_file(path)

    def test_file_reader_rejects_invalid_max_bytes_environment(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "evidence.json"
            path.write_text("{}", encoding="utf-8")
            with patch.dict(os.environ, {verifier.MAX_BYTES_ENV: "1.5"}):
                with self.assertRaisesRegex(ValueError, "positive base-10 integer"):
                    verifier.verify_evidence_file(path)


if __name__ == "__main__":
    unittest.main()
