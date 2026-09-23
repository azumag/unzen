from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import probe_llama_1b_endpoint_poststage_tiled_ort_cpu as probe  # noqa: E402


class PoststageSourceIdentityPreflightTests(unittest.TestCase):
    @staticmethod
    def _layout(identity: dict[str, object]) -> dict[str, object]:
        return {
            "kind": probe.layout_probe.REPORT_KIND,
            "schemaVersion": probe.layout_probe.REPORT_SCHEMA_VERSION,
            "status": "pass",
            "decisionStatus": "diagnostic-only",
            "rowBytes": 4,
            "rows": 8,
            "candidates": [
                {
                    "physicalArtifactCount": probe.PHYSICAL_ARTIFACT_COUNT,
                    "physicalArtifacts": [{} for _ in range(probe.PHYSICAL_ARTIFACT_COUNT)],
                    "executionTiles": [{} for _ in range(probe.EXECUTION_TILE_COUNT)],
                }
            ],
            "pinnedSourceExternalDataIdentity": identity,
            "sourceGraphSha256": "0" * 64,
        }

    def _assert_rejected_before_poststage_source_io(
        self, identity: dict[str, object]
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            payload_root = Path(tmp)
            with mock.patch.object(
                probe.layout_probe,
                "build_report",
                return_value=self._layout(identity),
            ):
                with mock.patch.object(
                    probe,
                    "_load_pinned_source_model",
                    side_effect=AssertionError(
                        "post-stage source graph reload must not run for invalid identity"
                    ),
                ) as source_model_mock:
                    with mock.patch.object(
                        probe.preferred_probe,
                        "_open_pinned_payload",
                        side_effect=AssertionError(
                            "source external-data opener must not run for invalid identity"
                        ),
                    ) as payload_mock:
                        with self.assertRaisesRegex(
                            RuntimeError,
                            "layout pinned source external-data identity is invalid",
                        ):
                            probe.build_report(
                                Path("/source/model.onnx"),
                                Path("/source/model.onnx_data"),
                                payload_root,
                            )
            source_model_mock.assert_not_called()
            payload_mock.assert_not_called()

    def test_invalid_source_external_byte_count_fails_before_poststage_source_io(self) -> None:
        for value in (True, False, 0, -1, 1.0, "1", None):
            with self.subTest(source_bytes=value):
                self._assert_rejected_before_poststage_source_io(
                    {"bytes": value, "sha256": "0" * 64}
                )

    def test_invalid_source_external_digest_fails_before_poststage_source_io(self) -> None:
        for value in (
            None,
            b"0" * 64,
            "",
            "0" * 63,
            "0" * 65,
            "g" * 64,
            "A" * 64,
            ("0" * 63) + "A",
        ):
            with self.subTest(source_sha256=value):
                self._assert_rejected_before_poststage_source_io(
                    {"bytes": 1, "sha256": value}
                )


if __name__ == "__main__":
    unittest.main()
