from __future__ import annotations

import hashlib
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
    def _fixture(
        self, root: Path
    ) -> tuple[
        Path,
        dict[str, object],
        list[dict[str, object]],
        dict[str, object],
        dict[str, object],
    ]:
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
        root.mkdir(parents=True, exist_ok=True)
        source_path = root / "weights.bin"
        source_bytes = b"HEADabcdefghTAIL"
        source_path.write_bytes(source_bytes)
        source_sha256 = hashlib.sha256(source_bytes).hexdigest()
        source_identity = {
            "location": "weights.bin",
            "bytes": len(source_bytes),
            "sha256": source_sha256,
        }
        provenance = {
            "probeKind": "probe-kind",
            "probeSchemaVersion": "1.2.0",
            "sourceGraphSha256": "1" * 64,
            "stageKind": "embedding-prefix",
            "tier": "preferred",
            "blueprintSha256": "2" * 64,
            "sourceExternalDataIdentity": source_identity,
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
                "bytes": len(source_bytes),
                "sha256": source_sha256,
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
                    "sourceEndOffsetBytesExclusive": chunks[index][
                        "sourceEndOffsetBytesExclusive"
                    ],
                }
                for index, data in enumerate(payload_bytes)
            ],
        }
        return source_path, materialization, chunks, provenance, source_identity

    def _pinned_probe_report(
        self,
        *,
        stage_kind: str = "embedding-prefix",
        tier: str = "preferred",
    ) -> dict[str, object]:
        chunks = verifier._expected_pinned_source_payload_chunks(
            stage_kind=stage_kind,
            tier=tier,
        )
        return {
            "kind": verifier.EXPECTED_PROBE_KIND,
            "schemaVersion": verifier.EXPECTED_PROBE_SCHEMA_VERSION,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": verifier.EXPECTED_SOURCE_GRAPH_SHA256,
            "pinnedSourceExternalDataIdentity": {
                "location": verifier.EXPECTED_SOURCE_LOCATION,
                "bytes": verifier.EXPECTED_SOURCE_BYTES,
                "sha256": verifier.EXPECTED_SOURCE_SHA256,
            },
            "endpointChunkEnvelope": {
                stage_kind: {
                    "tiers": {
                        tier: {
                            "feasible": True,
                            "balancedSourcePayloadChunks": chunks,
                        }
                    }
                }
            },
        }

    def test_independently_rehashes_source_ranges_and_exact_payload_set(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, materialization, chunks, provenance, source_identity = self._fixture(root)

            report = verifier.verify_materialization_payloads(
                source,
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
            self.assertEqual(report["source"]["sha256"], source_identity["sha256"])
            self.assertEqual(report["payloadCount"], 2)
            self.assertEqual(report["totalPayloadBytes"], 8)
            self.assertEqual(
                [item["sha256"] for item in report["payloads"]],
                [item["sourceRangeSha256"] for item in report["payloads"]],
            )

    def test_rejects_payload_and_report_collusion_against_pinned_source_range(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, materialization, chunks, provenance, source_identity = self._fixture(root)
            tampered = b"ijkl"
            (root / "payloads" / "payload-0001.bin").write_bytes(tampered)
            materialization["payloads"][1]["sha256"] = hashlib.sha256(tampered).hexdigest()

            with self.assertRaisesRegex(RuntimeError, "does not match pinned source range"):
                verifier.verify_materialization_payloads(
                    source,
                    materialization,
                    root / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=provenance,
                    expected_source_identity=source_identity,
                )

    def test_rejects_source_identity_tampering_before_payload_checks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, materialization, chunks, provenance, source_identity = self._fixture(root)
            source.write_bytes(b"HEADabcdEfghTAIL")

            with self.assertRaisesRegex(RuntimeError, "SHA-256 does not match pinned identity"):
                verifier.verify_materialization_payloads(
                    source,
                    materialization,
                    root / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=provenance,
                    expected_source_identity=source_identity,
                )

    def test_rejects_report_geometry_or_explicit_selection_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, materialization, chunks, provenance, source_identity = self._fixture(root)
            materialization["payloads"][0]["sourceOffsetBytes"] = 5
            with self.assertRaisesRegex(RuntimeError, "sourceOffsetBytes does not match pinned blueprint"):
                verifier.verify_materialization_payloads(
                    source,
                    materialization,
                    root / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=provenance,
                    expected_source_identity=source_identity,
                )

            source, materialization, chunks, provenance, source_identity = self._fixture(
                root / "second"
            )
            expected_other_selection = dict(provenance)
            expected_other_selection["stageKind"] = "logits-postfix"
            with self.assertRaisesRegex(RuntimeError, "explicit pinned probe selection"):
                verifier.verify_materialization_payloads(
                    source,
                    materialization,
                    root / "second" / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=expected_other_selection,
                    expected_source_identity=source_identity,
                )

    def test_rejects_extra_and_symlink_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, materialization, chunks, provenance, source_identity = self._fixture(root)
            extra = root / "payloads" / "payload-9999.bin"
            extra.write_bytes(b"extra")
            with self.assertRaisesRegex(RuntimeError, "directory contents do not match"):
                verifier.verify_materialization_payloads(
                    source,
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
                    source,
                    materialization,
                    root / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=provenance,
                    expected_source_identity=source_identity,
                )

    def test_rejects_source_snapshot_mutation_between_full_and_range_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, materialization, chunks, provenance, source_identity = self._fixture(root)
            original_sha256_file = verifier._sha256_file
            mutated = False

            def hash_then_mutate(path: Path, **kwargs: object) -> str:
                nonlocal mutated
                digest = original_sha256_file(path, **kwargs)
                if path == source and not mutated:
                    source.write_bytes(b"HEADabcdEfghTAIL")
                    mutated = True
                return digest

            with (
                mock.patch.object(verifier, "_sha256_file", side_effect=hash_then_mutate),
                self.assertRaisesRegex(RuntimeError, "file snapshot changed during verification"),
            ):
                verifier.verify_materialization_payloads(
                    source,
                    materialization,
                    root / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=provenance,
                    expected_source_identity=source_identity,
                    buffer_bytes=2,
                )

    def test_rejects_payload_snapshot_mutation_before_report_emission(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, materialization, chunks, provenance, source_identity = self._fixture(root)
            original_range_hash = verifier._sha256_file_range
            mutated = False

            def hash_then_mutate(path: Path, **kwargs: object) -> str:
                nonlocal mutated
                digest = original_range_hash(path, **kwargs)
                if kwargs.get("source_offset") == 8 and not mutated:
                    (root / "payloads" / "payload-0000.bin").write_bytes(b"zzzz")
                    mutated = True
                return digest

            with (
                mock.patch.object(verifier, "_sha256_file_range", side_effect=hash_then_mutate),
                self.assertRaisesRegex(RuntimeError, "file snapshot changed during verification"),
            ):
                verifier.verify_materialization_payloads(
                    source,
                    materialization,
                    root / "payloads",
                    expected_chunks=chunks,
                    expected_provenance=provenance,
                    expected_source_identity=source_identity,
                    buffer_bytes=2,
                )

    def test_pinned_contract_is_rederived_without_producer_helpers(self) -> None:
        report = self._pinned_probe_report()

        chunks = verifier._chunks_from_probe_report(
            report,
            stage_kind="embedding-prefix",
            tier="preferred",
        )
        provenance = verifier._materialization_provenance_from_probe_report(
            report,
            stage_kind="embedding-prefix",
            tier="preferred",
            chunks=chunks,
        )

        self.assertEqual(len(chunks), 4)
        self.assertEqual(chunks[0]["sourceOffsetBytes"], 0)
        self.assertEqual(
            chunks[-1]["sourceEndOffsetBytesExclusive"],
            1_050_673_152,
        )
        self.assertEqual(provenance["stageKind"], "embedding-prefix")
        self.assertEqual(provenance["tier"], "preferred")
        self.assertEqual(
            provenance["sourceExternalDataIdentity"],
            {
                "location": verifier.EXPECTED_SOURCE_LOCATION,
                "bytes": verifier.EXPECTED_SOURCE_BYTES,
                "sha256": verifier.EXPECTED_SOURCE_SHA256,
            },
        )

    def test_pinned_contract_rejects_self_consistent_probe_blueprint_drift(self) -> None:
        report = self._pinned_probe_report()
        selected = report["endpointChunkEnvelope"]["embedding-prefix"]["tiers"]["preferred"]
        chunks = selected["balancedSourcePayloadChunks"]
        chunks[0] = dict(chunks[0])
        chunks[1] = dict(chunks[1])
        chunks[0]["endRowExclusive"] -= 1
        chunks[0]["rowCount"] -= 1
        chunks[0]["sourceEndOffsetBytesExclusive"] -= verifier.EXPECTED_ROW_BYTES
        chunks[0]["payloadBytes"] -= verifier.EXPECTED_ROW_BYTES
        chunks[1]["startRow"] -= 1
        chunks[1]["rowCount"] += 1
        chunks[1]["sourceOffsetBytes"] -= verifier.EXPECTED_ROW_BYTES
        chunks[1]["payloadBytes"] += verifier.EXPECTED_ROW_BYTES

        with self.assertRaisesRegex(RuntimeError, "verifier-owned pinned blueprint"):
            verifier._chunks_from_probe_report(
                report,
                stage_kind="embedding-prefix",
                tier="preferred",
            )

    def test_pinned_wrapper_uses_verifier_owned_derivation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, materialization, chunks, provenance, source_identity = self._fixture(root)
            probe_report = {"kind": "synthetic"}

            with (
                mock.patch.object(
                    verifier,
                    "_chunks_from_probe_report",
                    return_value=chunks,
                ) as chunks_mock,
                mock.patch.object(
                    verifier,
                    "_materialization_provenance_from_probe_report",
                    return_value=provenance,
                ) as provenance_mock,
                mock.patch.object(
                    verifier,
                    "_source_identity_from_probe_report",
                    return_value=source_identity,
                ) as source_mock,
            ):
                report = verifier.verify_pinned_probe_materialization(
                    source,
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
