from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_endpoint_payload_materialization as verifier  # noqa: E402


class VerifyEndpointPayloadMaterializationTest(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[dict[str, object], list[dict[str, object]], dict[str, object], dict[str, object]]:
        chunks = [
            {
                "chunkIndex": 0,
                "startRow": 0,
                "endRowExclusive": 2,
                "rowCount": 2,
                "sourceLocation": "weights.bin",
                "sourceOffsetBytes": 4,
                "sourceEndOffsetBytesExclusive": 8,
                "payloadBytes": 4,
            },
            {
                "chunkIndex": 1,
                "startRow": 2,
                "endRowExclusive": 4,
                "rowCount": 2,
                "sourceLocation": "weights.bin",
                "sourceOffsetBytes": 8,
                "sourceEndOffsetBytesExclusive": 12,
                "payloadBytes": 4,
            },
        ]
        provenance = {
            "probeKind": "probe-kind",
            "probeSchemaVersion": "1.2.0",
            "sourceGraphSha256": "1" * 64,
            "stageKind": "embedding-prefix",
            "tier": "preferred",
            "blueprintSha256": "2" * 64,
            "sourceExternalDataIdentity": {
                "location": "weights.bin",
                "bytes": 16,
                "sha256": "3" * 64,
            },
        }
        source_identity = {
            "location": "weights.bin",
            "bytes": 16,
            "sha256": "3" * 64,
        }
        payload_dir = root / "payloads"
        payload_dir.mkdir()
        payload_bytes = [b"abcd", b"efgh"]
        for index, data in enumerate(payload_bytes):
            (payload_dir / f"payload-{index:04d}.bin").write_bytes(data)
        materialization = {
            "schemaVersion": verifier.EXPECTED_MATERIALIZATION_SCHEMA_VERSION,
            "kind": verifier.EXPECTED_MATERIALIZATION_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "provenance": provenance,
            "source": {
                "path": "/tmp/weights.bin",
                "bytes": 16,
                "sha256": "3" * 64,
                "blueprintLocation": "weights.bin",
                "coverageStartBytes": 4,
                "coverageEndBytesExclusive": 12,
            },
            "payloadCount": 2,
            "totalPayloadBytes": 8,
            "payloads": [
                {
                    "chunkIndex": index,
                    "outputFile": f"payload-{index:04d}.bin",
                    "bytes": 4,
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "startRow": chunks[index]["startRow"],
                    "endRowExclusive": chunks[index]["endRowExclusive"],
                    "sourceOffsetBytes": chunks[index]["sourceOffsetBytes"],
                    "sourceEndOffsetBytesExclusive": chunks[index]["sourceEndOffsetBytesExclusive"],
                }
                for index, data in enumerate(payload_bytes)
            ],
        }
        return materialization, chunks, provenance, source_identity

    def test_independently_rehashes_exact_payload_set(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            materialization, chunks, provenance, source_identity = self._fixture(root)

            report = verifier.verify_materialization_payloads(
                materialization,
                root / "payloads",
                expected_chunks=chunks,
                expected_provenance=provenance,
                expected_source_identity=source_identity,
                buffer_bytes=2,
            )

            self.assertEqual(report["schemaVersion"], "1.0.0")
            self.assertEqual(report["kind"], verifier.REPORT_KIND)
            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["decisionStatus"], "diagnostic-only")
            self.assertEqual(report["provenance"], provenance)
            self.assertEqual(report["payloadCount"], 2)
            self.assertEqual(report["totalPayloadBytes"], 8)
            self.assertEqual(
                [item["sha256"] for item in report["payloads"]],
                [item["sha256"] for item in materialization["payloads"]],
            )

    def test_rejects_payload_byte_tampering_even_when_report_is_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            materialization, chunks, provenance, source_identity = self._fixture(root)
            (root / "payloads" / "payload-0001.bin").write_bytes(b"ijkl")

            with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                verifier.verify_materialization_payloads(
                    materialization,
                    root / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=provenance,
                    expected_source_identity=source_identity,
                )

    def test_rejects_report_geometry_or_explicit_selection_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            materialization, chunks, provenance, source_identity = self._fixture(root)
            materialization["payloads"][0]["sourceOffsetBytes"] = 5
            with self.assertRaisesRegex(RuntimeError, "sourceOffsetBytes does not match pinned blueprint"):
                verifier.verify_materialization_payloads(
                    materialization,
                    root / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=provenance,
                    expected_source_identity=source_identity,
                )

            materialization, chunks, provenance, source_identity = self._fixture(root / "second")
            expected_other_selection = dict(provenance)
            expected_other_selection["stageKind"] = "logits-postfix"
            with self.assertRaisesRegex(RuntimeError, "explicit pinned probe selection"):
                verifier.verify_materialization_payloads(
                    materialization,
                    root / "second" / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=expected_other_selection,
                    expected_source_identity=source_identity,
                )

    def test_rejects_missing_extra_and_symlink_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            materialization, chunks, provenance, source_identity = self._fixture(root)
            extra = root / "payloads" / "payload-9999.bin"
            extra.write_bytes(b"extra")
            with self.assertRaisesRegex(RuntimeError, "directory contents do not match"):
                verifier.verify_materialization_payloads(
                    materialization,
                    root / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=provenance,
                    expected_source_identity=source_identity,
                )

            extra.unlink()
            payload = root / "payloads" / "payload-0001.bin"
            target = root / "target.bin"
            target.write_bytes(payload.read_bytes())
            payload.unlink()
            payload.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "refusing to verify symlink payload"):
                verifier.verify_materialization_payloads(
                    materialization,
                    root / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=provenance,
                    expected_source_identity=source_identity,
                )

    def test_pinned_wrapper_derives_expectations_from_explicit_stage_and_tier(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            materialization, chunks, provenance, source_identity = self._fixture(root)
            probe_report = {"kind": "synthetic"}

            with (
                mock.patch.object(verifier.materializer, "chunks_from_probe_report", return_value=chunks) as chunks_mock,
                mock.patch.object(
                    verifier.materializer,
                    "materialization_provenance_from_probe_report",
                    return_value=provenance,
                ) as provenance_mock,
                mock.patch.object(
                    verifier.materializer,
                    "source_identity_from_probe_report",
                    return_value=source_identity,
                ) as source_mock,
            ):
                report = verifier.verify_pinned_probe_materialization(
                    probe_report,
                    materialization,
                    root / "payloads",
                    stage_kind="embedding-prefix",
                    tier="preferred",
                )

            self.assertEqual(report["status"], "pass")
            chunks_mock.assert_called_once_with(
                probe_report,
                stage_kind="embedding-prefix",
                tier="preferred",
            )
            provenance_mock.assert_called_once_with(
                probe_report,
                stage_kind="embedding-prefix",
                tier="preferred",
                chunks=chunks,
            )
            source_mock.assert_called_once_with(probe_report)

    def test_json_loader_hashes_the_exact_bytes_it_parses(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            raw = b'{"status":"pass"}\n'
            path.write_bytes(raw)

            report, digest = verifier._load_json_with_sha256(path)

            self.assertEqual(report, {"status": "pass"})
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())


if __name__ == "__main__":
    unittest.main()
