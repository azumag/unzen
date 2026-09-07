from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
from unittest import mock
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import materialize_endpoint_payload_chunks as materializer  # noqa: E402
import probe_llama_1b_endpoint_chunk_envelope as probe_module  # noqa: E402


class MaterializeEndpointPayloadChunksTest(unittest.TestCase):
    def test_materializes_probe_blueprint_as_exact_contiguous_source_ranges(self) -> None:
        prefix = b"header!"
        payload = bytes(range(40))
        suffix = b"tail"
        chunks = probe_module._balanced_source_payload_chunks(
            rows=10,
            row_bytes=4,
            payload_count=3,
            location="weights.bin",
            source_offset_bytes=len(prefix),
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "weights.bin"
            source_bytes = prefix + payload + suffix
            source.write_bytes(source_bytes)
            output_dir = root / "chunks"

            report = materializer.materialize_source_payload_chunks(
                source,
                output_dir,
                chunks,
                buffer_bytes=5,
            )

            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["decisionStatus"], "diagnostic-only")
            self.assertEqual(report["schemaVersion"], "1.0.0")
            self.assertNotIn("provenance", report)
            self.assertEqual(report["payloadCount"], 3)
            self.assertEqual(report["totalPayloadBytes"], len(payload))
            outputs = [
                (output_dir / item["outputFile"]).read_bytes()
                for item in report["payloads"]
            ]
            self.assertEqual(b"".join(outputs), payload)
            self.assertEqual(
                [item["bytes"] for item in report["payloads"]],
                [16, 12, 12],
            )
            self.assertEqual(
                [item["sha256"] for item in report["payloads"]],
                [hashlib.sha256(output).hexdigest() for output in outputs],
            )
            self.assertEqual(report["source"]["sha256"], hashlib.sha256(source_bytes).hexdigest())
            self.assertEqual(report["source"]["coverageStartBytes"], len(prefix))
            self.assertEqual(
                report["source"]["coverageEndBytesExclusive"],
                len(prefix) + len(payload),
            )

    def test_rejects_non_contiguous_source_ranges_before_writing(self) -> None:
        chunks = probe_module._balanced_source_payload_chunks(
            rows=4,
            row_bytes=2,
            payload_count=2,
            location="weights.bin",
            source_offset_bytes=0,
        )
        chunks[1] = dict(chunks[1])
        chunks[1]["sourceOffsetBytes"] = 5
        chunks[1]["sourceEndOffsetBytesExclusive"] = 9

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "weights.bin"
            source.write_bytes(b"0123456789")
            output_dir = root / "chunks"

            with self.assertRaisesRegex(RuntimeError, "source byte coverage must be contiguous"):
                materializer.materialize_source_payload_chunks(source, output_dir, chunks)

            self.assertFalse(output_dir.exists())

    def test_rejects_inconsistent_row_byte_width(self) -> None:
        chunks = probe_module._balanced_source_payload_chunks(
            rows=4,
            row_bytes=2,
            payload_count=2,
            location="weights.bin",
            source_offset_bytes=0,
        )
        chunks[1] = dict(chunks[1])
        chunks[1]["sourceEndOffsetBytesExclusive"] = 10
        chunks[1]["payloadBytes"] = 6

        with self.assertRaisesRegex(RuntimeError, "row byte width must remain constant"):
            materializer.validate_source_payload_chunks(chunks)

    def test_rejects_truncated_source_before_writing(self) -> None:
        chunks = probe_module._balanced_source_payload_chunks(
            rows=4,
            row_bytes=2,
            payload_count=2,
            location="weights.bin",
            source_offset_bytes=3,
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "weights.bin"
            source.write_bytes(b"0123456789")
            output_dir = root / "chunks"

            with self.assertRaisesRegex(RuntimeError, "exceeds source file size"):
                materializer.materialize_source_payload_chunks(source, output_dir, chunks)

            self.assertFalse(output_dir.exists())

    def test_rejects_pinned_source_identity_mismatch_before_writing(self) -> None:
        chunks = probe_module._balanced_source_payload_chunks(
            rows=4,
            row_bytes=2,
            payload_count=2,
            location="weights.bin",
            source_offset_bytes=0,
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "weights.bin"
            source.write_bytes(b"01234567")
            output_dir = root / "chunks"

            with self.assertRaisesRegex(RuntimeError, "byte size does not match pinned identity"):
                materializer.materialize_source_payload_chunks(
                    source,
                    output_dir,
                    chunks,
                    expected_source_bytes=9,
                )
            self.assertFalse(output_dir.exists())

            with self.assertRaisesRegex(RuntimeError, "SHA-256 does not match pinned identity"):
                materializer.materialize_source_payload_chunks(
                    source,
                    output_dir,
                    chunks,
                    expected_source_bytes=8,
                    expected_source_sha256="0" * 64,
                )
            self.assertFalse(output_dir.exists())

    def test_refuses_to_overwrite_existing_payload(self) -> None:
        chunks = probe_module._balanced_source_payload_chunks(
            rows=4,
            row_bytes=2,
            payload_count=2,
            location="weights.bin",
            source_offset_bytes=0,
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "weights.bin"
            source.write_bytes(b"01234567")
            output_dir = root / "chunks"
            output_dir.mkdir()
            existing = output_dir / "payload-0000.bin"
            existing.write_bytes(b"keep")

            with self.assertRaises(FileExistsError):
                materializer.materialize_source_payload_chunks(source, output_dir, chunks)

            self.assertEqual(existing.read_bytes(), b"keep")
            self.assertFalse((output_dir / "payload-0001.bin").exists())

    def test_copy_exact_range_never_unlinks_a_preexisting_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "weights.bin"
            source_path.write_bytes(b"01234567")
            destination = root / "payload.bin"
            destination.write_bytes(b"keep")

            with source_path.open("rb") as source:
                with self.assertRaises(FileExistsError):
                    materializer._copy_exact_range(
                        source,
                        destination,
                        source_offset=0,
                        payload_bytes=4,
                        buffer_bytes=2,
                    )

            self.assertEqual(destination.read_bytes(), b"keep")

    def test_extracts_only_feasible_diagnostic_blueprint(self) -> None:
        chunks = materializer._expected_pinned_source_payload_chunks(
            stage_kind="embedding-prefix",
            tier="preferred",
        )
        report = {
            "kind": materializer.EXPECTED_PROBE_KIND,
            "schemaVersion": materializer.EXPECTED_PROBE_SCHEMA_VERSION,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "sourceGraphSha256": materializer.EXPECTED_SOURCE_GRAPH_SHA256,
            "pinnedSourceExternalDataIdentity": {
                "location": materializer.EXPECTED_SOURCE_LOCATION,
                "bytes": materializer.EXPECTED_SOURCE_BYTES,
                "sha256": materializer.EXPECTED_SOURCE_SHA256.upper(),
            },
            "endpointChunkEnvelope": {
                "embedding-prefix": {
                    "tiers": {
                        "preferred": {
                            "feasible": True,
                            "balancedSourcePayloadChunks": chunks,
                        }
                    }
                },
                "logits-postfix": {
                    "tiers": {
                        "preferred": {
                            "feasible": True,
                            "balancedSourcePayloadChunks": chunks,
                        }
                    }
                },
            },
        }

        observed = materializer.chunks_from_probe_report(
            json.loads(json.dumps(report)),
            stage_kind="embedding-prefix",
            tier="preferred",
        )

        self.assertEqual(observed, chunks)
        self.assertEqual(
            materializer.source_identity_from_probe_report(report),
            {
                "location": materializer.EXPECTED_SOURCE_LOCATION,
                "bytes": materializer.EXPECTED_SOURCE_BYTES,
                "sha256": materializer.EXPECTED_SOURCE_SHA256,
            },
        )
        prefix_provenance = materializer.materialization_provenance_from_probe_report(
            report,
            stage_kind="embedding-prefix",
            tier="preferred",
            chunks=chunks,
        )
        postfix_provenance = materializer.materialization_provenance_from_probe_report(
            report,
            stage_kind="logits-postfix",
            tier="preferred",
            chunks=chunks,
        )
        self.assertEqual(prefix_provenance["probeKind"], materializer.EXPECTED_PROBE_KIND)
        self.assertEqual(
            prefix_provenance["probeSchemaVersion"],
            materializer.EXPECTED_PROBE_SCHEMA_VERSION,
        )
        self.assertEqual(
            prefix_provenance["sourceGraphSha256"],
            materializer.EXPECTED_SOURCE_GRAPH_SHA256,
        )
        self.assertEqual(prefix_provenance["stageKind"], "embedding-prefix")
        self.assertEqual(prefix_provenance["tier"], "preferred")
        self.assertEqual(
            prefix_provenance["blueprintSha256"],
            materializer._canonical_json_sha256(chunks),
        )
        self.assertEqual(
            prefix_provenance["sourceExternalDataIdentity"],
            materializer.source_identity_from_probe_report(report),
        )
        self.assertEqual(
            prefix_provenance["blueprintSha256"],
            postfix_provenance["blueprintSha256"],
        )
        self.assertNotEqual(
            prefix_provenance["stageKind"],
            postfix_provenance["stageKind"],
        )

        synthetic_materialization = {
            "schemaVersion": "1.0.0",
            "kind": materializer.REPORT_KIND,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "payloads": [],
        }
        with mock.patch.object(
            materializer,
            "materialize_source_payload_chunks",
            return_value=synthetic_materialization.copy(),
        ) as materialize_mock:
            bound_report, bound_chunks = materializer.materialize_pinned_probe_payload_chunks(
                Path("model_q4.onnx_data"),
                Path("chunks"),
                report,
                stage_kind="embedding-prefix",
                tier="preferred",
            )
        self.assertEqual(bound_chunks, chunks)
        self.assertEqual(bound_report["schemaVersion"], "1.1.0")
        self.assertEqual(bound_report["provenance"], prefix_provenance)
        materialize_mock.assert_called_once_with(
            Path("model_q4.onnx_data"),
            Path("chunks"),
            chunks,
            buffer_bytes=materializer.DEFAULT_COPY_BUFFER_BYTES,
            expected_source_bytes=materializer.EXPECTED_SOURCE_BYTES,
            expected_source_sha256=materializer.EXPECTED_SOURCE_SHA256,
        )

        wrong_chunks = json.loads(json.dumps(chunks))
        wrong_chunks[0]["endRowExclusive"] -= 1
        with self.assertRaisesRegex(RuntimeError, "do not match the selected pinned probe blueprint"):
            materializer.materialization_provenance_from_probe_report(
                report,
                stage_kind="embedding-prefix",
                tier="preferred",
                chunks=wrong_chunks,
            )
        tampered = json.loads(json.dumps(report))
        tampered["pinnedSourceExternalDataIdentity"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "pinned external-data identity mismatch"):
            materializer.chunks_from_probe_report(
                tampered,
                stage_kind="embedding-prefix",
                tier="preferred",
            )

        tampered_chunks = json.loads(json.dumps(report))
        first, second = tampered_chunks["endpointChunkEnvelope"]["embedding-prefix"]["tiers"][
            "preferred"
        ]["balancedSourcePayloadChunks"][:2]
        first["endRowExclusive"] += 1
        first["rowCount"] += 1
        first["sourceEndOffsetBytesExclusive"] += materializer.EXPECTED_ROW_BYTES
        first["payloadBytes"] += materializer.EXPECTED_ROW_BYTES
        second["startRow"] += 1
        second["rowCount"] -= 1
        second["sourceOffsetBytes"] += materializer.EXPECTED_ROW_BYTES
        second["payloadBytes"] -= materializer.EXPECTED_ROW_BYTES
        materializer.validate_source_payload_chunks(
            tampered_chunks["endpointChunkEnvelope"]["embedding-prefix"]["tiers"]["preferred"][
                "balancedSourcePayloadChunks"
            ]
        )
        with self.assertRaisesRegex(RuntimeError, "does not match the pinned deterministic blueprint"):
            materializer.chunks_from_probe_report(
                tampered_chunks,
                stage_kind="embedding-prefix",
                tier="preferred",
            )

        report["decisionStatus"] = "approved"
        with self.assertRaisesRegex(RuntimeError, "decisionStatus"):
            materializer.chunks_from_probe_report(
                report,
                stage_kind="embedding-prefix",
                tier="preferred",
            )

    def test_report_output_cannot_collide_with_payload_or_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "weights.bin"
            source.write_bytes(b"01234567")
            output_dir = root / "chunks"

            with self.assertRaisesRegex(RuntimeError, "must not collide with a materialized payload"):
                materializer._validate_report_output_path(
                    output_dir / "payload-0000.bin",
                    source_path=source,
                    output_dir=output_dir,
                    payload_count=2,
                )

            existing_report = root / "report.json"
            existing_report.write_text("keep", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                materializer._validate_report_output_path(
                    existing_report,
                    source_path=source,
                    output_dir=output_dir,
                    payload_count=2,
                )
            self.assertEqual(existing_report.read_text(encoding="utf-8"), "keep")

    def test_rejects_unsafe_blueprint_location(self) -> None:
        chunks = probe_module._balanced_source_payload_chunks(
            rows=2,
            row_bytes=2,
            payload_count=1,
            location="../weights.bin",
            source_offset_bytes=0,
        )

        with self.assertRaisesRegex(RuntimeError, "unsafe source location"):
            materializer.validate_source_payload_chunks(chunks)

        windows_style = probe_module._balanced_source_payload_chunks(
            rows=2,
            row_bytes=2,
            payload_count=1,
            location="..\\weights.bin",
            source_offset_bytes=0,
        )
        with self.assertRaisesRegex(RuntimeError, "unsafe source location"):
            materializer.validate_source_payload_chunks(windows_style)


if __name__ == "__main__":
    unittest.main()
