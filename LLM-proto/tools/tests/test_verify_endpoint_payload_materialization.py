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
        budget = verifier._expected_pinned_tier_budget(
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
                    "rows": verifier.EXPECTED_ROWS,
                    "rowBytes": verifier.EXPECTED_ROW_BYTES,
                    "largestRangeBytes": verifier.EXPECTED_ROWS * verifier.EXPECTED_ROW_BYTES,
                    "sourceLocation": verifier.EXPECTED_SOURCE_LOCATION,
                    "sourceOffsetBytes": verifier.EXPECTED_SOURCE_OFFSET_BYTES,
                    "sourceStageResidualBytes": verifier.EXPECTED_STAGE_RESIDUAL_BYTES[stage_kind],
                    "tiers": {
                        tier: {
                            **budget,
                            "balancedSourcePayloadChunks": chunks,
                        }
                    },
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

    def test_hashes_full_source_and_ranges_in_one_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.bin"
            data = b"0123456789abcdef"
            source.write_bytes(data)

            full_sha256, range_sha256_values = verifier._sha256_file_and_ranges(
                source,
                ranges=[(1, 5), (6, 3), (12, 4)],
                buffer_bytes=4,
            )

            self.assertEqual(full_sha256, hashlib.sha256(data).hexdigest())
            self.assertEqual(
                range_sha256_values,
                [
                    hashlib.sha256(data[1:6]).hexdigest(),
                    hashlib.sha256(data[6:9]).hexdigest(),
                    hashlib.sha256(data[12:16]).hexdigest(),
                ],
            )

    def test_rejects_source_snapshot_mutation_after_single_source_hash_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, materialization, chunks, provenance, source_identity = self._fixture(root)
            original_source_hash = verifier._sha256_file_and_ranges
            mutated = False

            def hash_then_mutate(path: Path, **kwargs: object) -> tuple[str, list[str]]:
                nonlocal mutated
                digests = original_source_hash(path, **kwargs)
                if path == source and not mutated:
                    source.write_bytes(b"HEADabcdEfghTAIL")
                    mutated = True
                return digests

            with (
                mock.patch.object(
                    verifier,
                    "_sha256_file_and_ranges",
                    side_effect=hash_then_mutate,
                ),
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
            original_file_hash = verifier._sha256_file
            mutated = False

            def hash_then_mutate(path: Path, **kwargs: object) -> str:
                nonlocal mutated
                digest = original_file_hash(path, **kwargs)
                if path.name == "payload-0001.bin" and not mutated:
                    (root / "payloads" / "payload-0000.bin").write_bytes(b"zzzz")
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

    def test_rejects_payload_namespace_mutation_before_report_emission(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, materialization, chunks, provenance, source_identity = self._fixture(root)
            original_file_hash = verifier._sha256_file
            mutated = False

            def hash_then_add_extra_payload(path: Path, **kwargs: object) -> str:
                nonlocal mutated
                digest = original_file_hash(path, **kwargs)
                if path.name == "payload-0001.bin" and not mutated:
                    (root / "payloads" / "payload-9999.bin").write_bytes(b"extra")
                    mutated = True
                return digest

            with (
                mock.patch.object(
                    verifier,
                    "_sha256_file",
                    side_effect=hash_then_add_extra_payload,
                ),
                self.assertRaisesRegex(RuntimeError, "directory contents do not match"),
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

    def test_pinned_contract_rejects_tier_budget_drift(self) -> None:
        report = self._pinned_probe_report()
        selected = report["endpointChunkEnvelope"]["embedding-prefix"]["tiers"]["preferred"]
        selected["remainingHeadroomBytes"] += 1

        with self.assertRaisesRegex(RuntimeError, "verifier-owned pinned budget"):
            verifier._chunks_from_probe_report(
                report,
                stage_kind="embedding-prefix",
                tier="preferred",
            )

    def test_pinned_contract_rejects_stage_residual_drift(self) -> None:
        report = self._pinned_probe_report()
        stage = report["endpointChunkEnvelope"]["embedding-prefix"]
        stage["sourceStageResidualBytes"] += 1

        with self.assertRaisesRegex(RuntimeError, "verifier-owned pinned budget"):
            verifier._chunks_from_probe_report(
                report,
                stage_kind="embedding-prefix",
                tier="preferred",
            )

    def test_pinned_budget_derivation_matches_preferred_endpoint_envelopes(self) -> None:
        embedding = verifier._expected_pinned_tier_budget(
            stage_kind="embedding-prefix",
            tier="preferred",
        )
        logits = verifier._expected_pinned_tier_budget(
            stage_kind="logits-postfix",
            tier="preferred",
        )

        self.assertEqual(embedding["limitBytes"], 268_435_456)
        self.assertEqual(embedding["minimumPayloadCount"], 4)
        self.assertEqual(embedding["balancedMaximumPayloadBytes"], 262_668_288)
        self.assertEqual(embedding["remainingHeadroomBytes"], 5_766_668)
        self.assertEqual(logits["minimumPayloadCount"], 4)
        self.assertEqual(logits["remainingHeadroomBytes"], 5_757_614)

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
                mock.patch.object(
                    verifier,
                    "_expected_pinned_tier_budget",
                    return_value={
                        "limitBytes": 16,
                        "maximumWholeRowsPerArtifact": 7,
                        "minimumPayloadCount": 2,
                        "balancedMaximumRows": 2,
                        "balancedMaximumPayloadBytes": 4,
                        "conservativeMaximumArtifactBytes": 6,
                        "remainingHeadroomBytes": 10,
                        "feasible": True,
                    },
                ) as budget_mock,
                mock.patch.dict(
                    verifier.EXPECTED_STAGE_RESIDUAL_BYTES,
                    {"embedding-prefix": 2},
                ),
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
            self.assertEqual(report["schemaVersion"], verifier.REPORT_SCHEMA_VERSION)
            self.assertEqual(report["budget"]["limitBytes"], 16)
            self.assertEqual(report["budget"]["sourceStageResidualBytes"], 2)
            self.assertEqual(report["budget"]["verifiedMaximumPayloadBytes"], 4)
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
            budget_mock.assert_called_once_with(
                stage_kind="embedding-prefix",
                tier="preferred",
            )

    def test_report_output_cannot_create_post_verification_payload_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload_dir = root / "payloads"
            payload_dir.mkdir()

            with self.assertRaisesRegex(RuntimeError, r"reserved payload-\*\.bin namespace"):
                verifier._validate_report_output_path(
                    payload_dir / "payload-9999.bin",
                    payload_dir=payload_dir,
                )

            with self.assertRaisesRegex(RuntimeError, r"reserved payload-\*\.bin namespace"):
                verifier._validate_report_output_path(
                    payload_dir / "payload-9999.bin" / "verification.json",
                    payload_dir=payload_dir,
                )

            verifier._validate_report_output_path(
                payload_dir / "reports" / "verification-report.json",
                payload_dir=payload_dir,
            )

            existing_report = root / "verification.json"
            existing_report.write_text("keep", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                verifier._validate_report_output_path(
                    existing_report,
                    payload_dir=payload_dir,
                )
            self.assertEqual(existing_report.read_text(encoding="utf-8"), "keep")

    def test_main_rechecks_report_alias_after_parent_creation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "weights.bin"
            source.write_bytes(b"source")
            probe_report = root / "probe.json"
            probe_report.write_text("{}", encoding="utf-8")
            materialization_report = root / "materialization.json"
            materialization_report.write_text("{}", encoding="utf-8")
            payload_dir = root / "payloads"
            payload_dir.mkdir()
            safe_dir = root / "safe-reports"
            safe_dir.mkdir()
            reserved_dir = payload_dir / "payload-9999.bin"
            reserved_dir.mkdir()
            report_alias = root / "report-alias"
            report_alias.symlink_to(safe_dir, target_is_directory=True)
            report_out = report_alias / "verification.json"
            real_mkdir = Path.mkdir

            def retarget_after_mkdir(path: Path, *args: object, **kwargs: object) -> None:
                real_mkdir(path, *args, **kwargs)
                if path == report_alias:
                    report_alias.unlink()
                    report_alias.symlink_to(reserved_dir, target_is_directory=True)

            argv = [
                "verify_endpoint_payload_materialization.py",
                str(source),
                str(probe_report),
                str(materialization_report),
                str(payload_dir),
                "--stage",
                "embedding-prefix",
                "--tier",
                "preferred",
                "--report-out",
                str(report_out),
            ]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(
                    verifier,
                    "_load_json_with_sha256",
                    side_effect=[({}, "probe-digest"), ({}, "materialization-digest")],
                ),
                mock.patch.object(
                    verifier,
                    "verify_pinned_probe_materialization",
                    return_value={"status": "pass"},
                ),
                mock.patch.object(
                    Path, "mkdir", autospec=True, side_effect=retarget_after_mkdir
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, r"reserved payload-\*\.bin namespace"):
                    verifier.main()

            self.assertFalse((reserved_dir / "verification.json").exists())

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
