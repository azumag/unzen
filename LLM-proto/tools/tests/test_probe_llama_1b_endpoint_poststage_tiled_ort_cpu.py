from __future__ import annotations

from pathlib import Path
import hashlib
import os
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
import onnx
from onnx import TensorProto, helper


TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import probe_llama_1b_endpoint_layout_candidates as layout_fixture  # noqa: E402
import probe_llama_1b_endpoint_poststage_tiled_ort_cpu as probe  # noqa: E402


class PoststageTiledOrtCpuProbeTests(unittest.TestCase):
    ROWS = 16
    HIDDEN = 8
    ROW_BYTES = HIDDEN * 4

    @staticmethod
    def _external_tensor(
        name: str, dims: list[int], *, offset: int, length: int
    ) -> TensorProto:
        tensor = TensorProto()
        tensor.name = name
        tensor.data_type = TensorProto.FLOAT
        tensor.dims.extend(dims)
        tensor.data_location = TensorProto.EXTERNAL
        for key, value in (
            ("location", probe.EXPECTED_SOURCE_LOCATION),
            ("offset", str(offset)),
            ("length", str(length)),
        ):
            entry = tensor.external_data.add()
            entry.key = key
            entry.value = value
        return tensor

    def _source_model(
        self, *, epsilon: float | None = None, transpose_perm: list[int] | None = None
    ) -> tuple[onnx.ModelProto, np.ndarray, np.ndarray]:
        weight = (
            np.arange(self.ROWS * self.HIDDEN, dtype=np.float32)
            .reshape(self.ROWS, self.HIDDEN)
            / np.float32(100.0)
        ).astype("<f4")
        norm = np.linspace(0.5, 1.5, self.HIDDEN, dtype=np.float32).astype("<f4")
        weight_bytes = weight.nbytes
        nodes = [
            probe._final_norm_node(
                probe.FINAL_NORM_EPSILON if epsilon is None else epsilon
            ),
            helper.make_node(
                "Transpose",
                [probe.TIED_WEIGHT_NAME],
                ["/lm_head/Transpose/output_0"],
                name=probe.LM_HEAD_TRANSPOSE_NODE_NAME,
                perm=[1, 0] if transpose_perm is None else transpose_perm,
            ),
            helper.make_node(
                "MatMul",
                [probe.FINAL_NORM_OUTPUT, "/lm_head/Transpose/output_0"],
                [probe.LOGITS_OUTPUT],
                name=probe.LM_HEAD_MATMUL_NODE_NAME,
            ),
        ]
        graph = helper.make_graph(
            nodes,
            "poststage-fixture",
            [],
            [],
            [
                self._external_tensor(
                    probe.TIED_WEIGHT_NAME,
                    [self.ROWS, self.HIDDEN],
                    offset=0,
                    length=weight_bytes,
                ),
                self._external_tensor(
                    probe.FINAL_NORM_INPUTS[2],
                    [self.HIDDEN],
                    offset=weight_bytes,
                    length=norm.nbytes,
                ),
            ],
        )
        model = helper.make_model(
            graph,
            opset_imports=[
                helper.make_opsetid("", 21),
                helper.make_opsetid("com.microsoft", 1),
            ],
            ir_version=10,
        )
        return model, weight, norm

    def _layout_report(self, *, status: str = "pass", decision_status: str = "diagnostic-only"):
        return {
            "schemaVersion": layout_fixture.REPORT_SCHEMA_VERSION,
            "kind": layout_fixture.REPORT_KIND,
            "status": status,
            "decisionStatus": decision_status,
            "rows": self.ROWS,
            "rowBytes": self.ROW_BYTES,
            "candidates": [
                layout_fixture._candidate(
                    rows=self.ROWS,
                    row_bytes=self.ROW_BYTES,
                    source_offset_bytes=0,
                    physical_count=4,
                )
            ],
        }

    def test_build_report_runs_complete_contract_on_tiny_fixture(self) -> None:
        model, weight, norm = self._source_model()
        candidate = self._layout_report()["candidates"][0]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_model = root / "model_q4.onnx"
            onnx.save_model(model, source_model)
            source_external = root / probe.EXPECTED_SOURCE_LOCATION
            source_raw = weight.tobytes(order="C") + norm.tobytes(order="C")
            source_external.write_bytes(source_raw)
            source_sha256 = hashlib.sha256(source_raw).hexdigest()
            payload_root = root / "payloads"
            payload_root.mkdir()
            payload_hashes: dict[int, str] = {}
            for artifact in candidate["physicalArtifacts"]:
                index = artifact["index"]
                raw = weight[
                    artifact["startRow"] : artifact["endRowExclusive"]
                ].tobytes(order="C")
                (payload_root / f"payload-{index:04d}.bin").write_bytes(raw)
                payload_hashes[index] = hashlib.sha256(raw).hexdigest()

            layout = self._layout_report()
            layout.update(
                {
                    "sourceGraphSha256": hashlib.sha256(source_model.read_bytes()).hexdigest(),
                    "pinnedSourceExternalDataIdentity": {
                        "location": probe.EXPECTED_SOURCE_LOCATION,
                        "bytes": len(source_raw),
                        "sha256": source_sha256,
                    },
                }
            )
            with (
                mock.patch.object(probe.layout_probe, "build_report", return_value=layout),
                mock.patch.object(
                    probe.preferred_probe,
                    "PINNED_PREFERRED_PAYLOAD_SHA256",
                    payload_hashes,
                ),
                mock.patch.object(probe, "EXPECTED_TIED_WEIGHT_BYTES", weight.nbytes),
                mock.patch.object(probe, "EXPECTED_FINAL_NORM_WEIGHT_OFFSET", weight.nbytes),
                mock.patch.object(probe, "EXPECTED_FINAL_NORM_WEIGHT_BYTES", norm.nbytes),
            ):
                report = probe.build_report(source_model, source_external, payload_root)

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["decisionStatus"], "diagnostic-only")
        self.assertTrue(report["finalNormComparison"]["exactEqual"])
        self.assertTrue(report["logitsComparison"]["exactEqual"])
        self.assertEqual(len(report["perExecutionTileLogitsComparison"]), 8)
        self.assertTrue(
            all(item["matchesPinnedSourceRange"] for item in report["verifiedPhysicalPayloads"])
        )

    def test_reference_and_eight_tile_poststage_are_exact_for_tiny_fixture(self) -> None:
        model, weight, norm = self._source_model()
        contract = probe._poststage_contract(model, rows=self.ROWS, hidden_size=self.HIDDEN)
        candidate = self._layout_report()["candidates"][0]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.bin"
            source.write_bytes(weight.tobytes(order="C") + norm.tobytes(order="C"))
            source_fd = os.open(source, os.O_RDONLY)
            payload_fds: dict[int, int] = {}
            try:
                for artifact in candidate["physicalArtifacts"]:
                    index = artifact["index"]
                    payload = root / f"payload-{index:04d}.bin"
                    payload.write_bytes(
                        weight[
                            artifact["startRow"] : artifact["endRowExclusive"]
                        ].tobytes(order="C")
                    )
                    payload_fds[index] = os.open(payload, os.O_RDONLY)

                reference = probe._build_reference_model(
                    contract=contract,
                    source_fd=source_fd,
                    hidden_size=self.HIDDEN,
                    rows=self.ROWS,
                )
                tiled = probe._build_tiled_model(
                    contract=contract,
                    payload_fds=payload_fds,
                    execution_tiles=candidate["executionTiles"],
                    source_fd=source_fd,
                    hidden_size=self.HIDDEN,
                    rows=self.ROWS,
                )
                try:
                    feeds = probe._inputs(self.HIDDEN)
                    reference_logits, reference_norm, _ = probe._run_model(reference, feeds)
                    tiled_logits, tiled_norm, _ = probe._run_model(tiled, feeds)
                finally:
                    reference.unlink(missing_ok=True)
                    tiled.unlink(missing_ok=True)
            finally:
                for fd in payload_fds.values():
                    os.close(fd)
                os.close(source_fd)

        logits = probe._comparison(tiled_logits, reference_logits)
        final_norm = probe._comparison(tiled_norm, reference_norm)
        self.assertTrue(logits["exactEqual"])
        self.assertEqual(logits["maxAbsDiff"], 0.0)
        self.assertTrue(final_norm["exactEqual"])
        self.assertEqual(final_norm["maxAbsDiff"], 0.0)

    def test_source_final_norm_epsilon_drift_is_rejected(self) -> None:
        model, _, _ = self._source_model(epsilon=1e-4)
        with self.assertRaisesRegex(RuntimeError, "epsilon drift"):
            probe._poststage_contract(model, rows=self.ROWS, hidden_size=self.HIDDEN)

    def test_source_lm_head_transpose_drift_is_rejected(self) -> None:
        model, _, _ = self._source_model(transpose_perm=[0, 1])
        with self.assertRaisesRegex(RuntimeError, "permutation drift"):
            probe._poststage_contract(model, rows=self.ROWS, hidden_size=self.HIDDEN)

    def test_tiled_graph_rejects_row_coverage_gap(self) -> None:
        model, weight, norm = self._source_model()
        contract = probe._poststage_contract(model, rows=self.ROWS, hidden_size=self.HIDDEN)
        candidate = self._layout_report()["candidates"][0]
        tiles = [dict(tile) for tile in candidate["executionTiles"]]
        tiles[1]["startRow"] += 1

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.bin"
            source.write_bytes(weight.tobytes(order="C") + norm.tobytes(order="C"))
            source_fd = os.open(source, os.O_RDONLY)
            payload_fds: dict[int, int] = {}
            try:
                for artifact in candidate["physicalArtifacts"]:
                    payload = root / f"payload-{artifact['index']:04d}.bin"
                    payload.write_bytes(
                        weight[
                            artifact["startRow"] : artifact["endRowExclusive"]
                        ].tobytes(order="C")
                    )
                    payload_fds[artifact["index"]] = os.open(payload, os.O_RDONLY)
                with self.assertRaisesRegex(RuntimeError, "ordered and row-contiguous"):
                    probe._build_tiled_model(
                        contract=contract,
                        payload_fds=payload_fds,
                        execution_tiles=tiles,
                        source_fd=source_fd,
                        hidden_size=self.HIDDEN,
                        rows=self.ROWS,
                    )
            finally:
                for fd in payload_fds.values():
                    os.close(fd)
                os.close(source_fd)

    def test_layout_failure_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "layout report must pass"):
            probe._validate_layout(self._layout_report(status="fail"))

    def test_layout_decision_promotion_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "must remain diagnostic-only"):
            probe._validate_layout(self._layout_report(decision_status="approved"))

    def test_boolean_layout_rows_are_rejected(self) -> None:
        report = self._layout_report()
        report["rows"] = True
        with self.assertRaisesRegex(RuntimeError, "rows must be positive"):
            probe._validate_layout(report)

    def test_pinned_external_offsets_fail_closed(self) -> None:
        model, _, _ = self._source_model()
        contract = probe._poststage_contract(model, rows=self.ROWS, hidden_size=self.HIDDEN)
        with self.assertRaisesRegex(RuntimeError, "external-data tied bytes drift"):
            probe._validate_pinned_poststage_offsets(contract)


if __name__ == "__main__":
    unittest.main()
