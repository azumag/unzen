from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import probe_llama_1b_endpoint_chunk_envelope as probe_module  # noqa: E402


class ProbeLlama1BEndpointChunkEnvelopeTest(unittest.TestCase):
    @staticmethod
    def _stage(
        *,
        graph_bytes: int,
        unique_external_bytes: int,
        largest_range_bytes: int,
        rows: int,
        row_bytes: int,
        source_location: str = "weights.bin",
        source_offset_bytes: int = 0,
    ) -> dict[str, object]:
        return {
            "estimatedGraphBytes": graph_bytes,
            "externalDataLayout": {
                "uniqueExternalBytes": unique_external_bytes,
                "largestRangeBytes": largest_range_bytes,
                "largestRange": {
                    "location": source_location,
                    "offset": source_offset_bytes,
                    "bytes": largest_range_bytes,
                },
                "firstAxisPayloadChunkLowerBound": {
                    "available": True,
                    "rows": rows,
                    "rowBytes": row_bytes,
                    "rangeBytes": largest_range_bytes,
                },
            },
        }

    def test_co_located_residual_can_raise_minimum_chunk_count(self) -> None:
        stage = self._stage(
            graph_bytes=10,
            unique_external_bytes=110,
            largest_range_bytes=100,
            rows=10,
            row_bytes=10,
            source_offset_bytes=100,
        )

        with patch.object(probe_module, "TIER_LIMITS", (("tiny", 55),)):
            envelope = probe_module._co_located_residual_envelope(stage)

        self.assertEqual(envelope["sourceStageResidualBytes"], 20)
        tier = envelope["tiers"]["tiny"]
        self.assertTrue(tier["feasible"])
        self.assertEqual(tier["maximumWholeRowsPerArtifact"], 3)
        self.assertEqual(tier["minimumPayloadCount"], 4)
        self.assertEqual(tier["balancedMaximumRows"], 3)
        self.assertEqual(tier["balancedMaximumPayloadBytes"], 30)
        self.assertEqual(tier["conservativeMaximumArtifactBytes"], 50)
        self.assertEqual(tier["remainingHeadroomBytes"], 5)
        self.assertEqual(
            tier["balancedSourcePayloadChunks"],
            [
                {
                    "chunkIndex": 0,
                    "startRow": 0,
                    "endRowExclusive": 3,
                    "rowCount": 3,
                    "sourceLocation": "weights.bin",
                    "sourceOffsetBytes": 100,
                    "sourceEndOffsetBytesExclusive": 130,
                    "payloadBytes": 30,
                },
                {
                    "chunkIndex": 1,
                    "startRow": 3,
                    "endRowExclusive": 6,
                    "rowCount": 3,
                    "sourceLocation": "weights.bin",
                    "sourceOffsetBytes": 130,
                    "sourceEndOffsetBytesExclusive": 160,
                    "payloadBytes": 30,
                },
                {
                    "chunkIndex": 2,
                    "startRow": 6,
                    "endRowExclusive": 8,
                    "rowCount": 2,
                    "sourceLocation": "weights.bin",
                    "sourceOffsetBytes": 160,
                    "sourceEndOffsetBytesExclusive": 180,
                    "payloadBytes": 20,
                },
                {
                    "chunkIndex": 3,
                    "startRow": 8,
                    "endRowExclusive": 10,
                    "rowCount": 2,
                    "sourceLocation": "weights.bin",
                    "sourceOffsetBytes": 180,
                    "sourceEndOffsetBytesExclusive": 200,
                    "payloadBytes": 20,
                },
            ],
        )

    def test_co_located_residual_fails_when_no_row_can_fit(self) -> None:
        stage = self._stage(
            graph_bytes=30,
            unique_external_bytes=110,
            largest_range_bytes=100,
            rows=10,
            row_bytes=10,
        )

        with patch.object(probe_module, "TIER_LIMITS", (("tiny", 35),)):
            envelope = probe_module._co_located_residual_envelope(stage)

        tier = envelope["tiers"]["tiny"]
        self.assertFalse(tier["feasible"])
        self.assertIsNone(tier["minimumPayloadCount"])
        self.assertEqual(
            tier["reason"], "source-stage-residual-leaves-no-room-for-one-row"
        )

    def test_validate_report_pins_real_stage_residual_envelopes(self) -> None:
        stages = []
        for stage_kind, expected in probe_module.EXPECTED_STAGE_ENVELOPES.items():
            residual = expected["sourceStageResidualBytes"]
            stages.append(
                {
                    "stageKind": stage_kind,
                    "estimatedGraphBytes": residual,
                    "externalDataLayout": {
                        "uniqueExternalBytes": probe_module.EXPECTED_LARGEST_RANGE_BYTES,
                        "largestRangeBytes": probe_module.EXPECTED_LARGEST_RANGE_BYTES,
                        "largestRange": {
                            "location": probe_module.EXPECTED_SOURCE_LOCATION,
                            "offset": probe_module.EXPECTED_SOURCE_OFFSET_BYTES,
                            "bytes": probe_module.EXPECTED_LARGEST_RANGE_BYTES,
                        },
                        "firstAxisPayloadChunkLowerBound": {
                            "available": True,
                            "rows": probe_module.EXPECTED_ROWS,
                            "rowBytes": probe_module.EXPECTED_ROW_BYTES,
                            "rangeBytes": probe_module.EXPECTED_LARGEST_RANGE_BYTES,
                        },
                    },
                }
            )
        report = {
            "sourceModel": {"graphSha256": probe_module.EXPECTED_GRAPH_SHA256},
            "endpointIsolationCandidates": {"available": True, "stages": stages},
        }

        result = probe_module.validate_report(report)

        self.assertEqual(result["schemaVersion"], "1.2.0")
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["decisionStatus"], "diagnostic-only")
        self.assertEqual(
            result["pinnedSourceExternalDataIdentity"],
            {
                "location": probe_module.EXPECTED_SOURCE_LOCATION,
                "bytes": probe_module.EXPECTED_SOURCE_DATA_BYTES,
                "sha256": probe_module.EXPECTED_SOURCE_DATA_SHA256,
            },
        )
        preferred = result["endpointChunkEnvelope"]["logits-postfix"]["tiers"][
            "preferred"
        ]
        self.assertEqual(preferred["minimumPayloadCount"], 4)
        self.assertEqual(preferred["remainingHeadroomBytes"], 5_757_614)
        chunks = preferred["balancedSourcePayloadChunks"]
        self.assertEqual(len(chunks), 4)
        self.assertEqual([item["rowCount"] for item in chunks], [32_064] * 4)
        self.assertEqual(chunks[0]["sourceOffsetBytes"], 0)
        self.assertEqual(
            chunks[-1]["sourceEndOffsetBytesExclusive"],
            probe_module.EXPECTED_LARGEST_RANGE_BYTES,
        )

    def test_validate_report_rejects_graph_identity_drift(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "source graph SHA-256"):
            probe_module.validate_report(
                {
                    "sourceModel": {"graphSha256": "0" * 64},
                    "endpointIsolationCandidates": {"available": True, "stages": []},
                }
            )


if __name__ == "__main__":
    unittest.main()
