from __future__ import annotations

import hashlib
from pathlib import Path
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

import prepare_llama_1b_endpoint_poststage_tiled_ort_webgpu as prep  # noqa: E402
import probe_llama_1b_endpoint_layout_candidates as layout_fixture  # noqa: E402


class EndpointPoststageTiledOrtWebGpuPreparationTests(unittest.TestCase):
    ROWS = 16
    HIDDEN = 8
    ROW_BYTES = HIDDEN * 4

    @staticmethod
    def _external_tensor(name: str, dims: list[int], *, offset: int, length: int) -> TensorProto:
        tensor = TensorProto()
        tensor.name = name
        tensor.data_type = TensorProto.FLOAT
        tensor.dims.extend(dims)
        tensor.data_location = TensorProto.EXTERNAL
        for key, value in (
            ("location", prep.poststage_cpu.EXPECTED_SOURCE_LOCATION),
            ("offset", str(offset)),
            ("length", str(length)),
        ):
            item = tensor.external_data.add()
            item.key = key
            item.value = value
        return tensor

    def _source_model(self) -> tuple[onnx.ModelProto, np.ndarray, np.ndarray]:
        weight = (
            np.arange(self.ROWS * self.HIDDEN, dtype=np.float32)
            .reshape(self.ROWS, self.HIDDEN)
            / np.float32(100.0)
        ).astype("<f4")
        norm = np.linspace(0.5, 1.5, self.HIDDEN, dtype=np.float32).astype("<f4")
        nodes = [
            prep.poststage_cpu._final_norm_node(prep.poststage_cpu.FINAL_NORM_EPSILON),
            helper.make_node(
                "Transpose",
                [prep.poststage_cpu.TIED_WEIGHT_NAME],
                ["/lm_head/Transpose/output_0"],
                name=prep.poststage_cpu.LM_HEAD_TRANSPOSE_NODE_NAME,
                perm=[1, 0],
            ),
            helper.make_node(
                "MatMul",
                [prep.poststage_cpu.FINAL_NORM_OUTPUT, "/lm_head/Transpose/output_0"],
                [prep.poststage_cpu.LOGITS_OUTPUT],
                name=prep.poststage_cpu.LM_HEAD_MATMUL_NODE_NAME,
            ),
        ]
        graph = helper.make_graph(
            nodes,
            "poststage-webgpu-prep-fixture",
            [],
            [],
            [
                self._external_tensor(
                    prep.poststage_cpu.TIED_WEIGHT_NAME,
                    [self.ROWS, self.HIDDEN],
                    offset=0,
                    length=weight.nbytes,
                ),
                self._external_tensor(
                    prep.poststage_cpu.FINAL_NORM_INPUTS[2],
                    [self.HIDDEN],
                    offset=weight.nbytes,
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

    def _layout_report(
        self,
        *,
        source_graph_sha256: str,
        source_bytes: int,
        source_sha256: str,
        decision_status: str = "diagnostic-only",
    ) -> dict[str, object]:
        return {
            "schemaVersion": layout_fixture.REPORT_SCHEMA_VERSION,
            "kind": layout_fixture.REPORT_KIND,
            "status": "pass",
            "decisionStatus": decision_status,
            "sourceGraphSha256": source_graph_sha256,
            "pinnedSourceExternalDataIdentity": {
                "location": prep.poststage_cpu.EXPECTED_SOURCE_LOCATION,
                "bytes": source_bytes,
                "sha256": source_sha256,
            },
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

    def _patches(
        self,
        *,
        layout: dict[str, object],
        weight: np.ndarray,
        norm: np.ndarray,
        source_bytes: int,
        source_sha256: str,
        payload_hashes: dict[int, str],
    ):
        return (
            mock.patch.object(prep.layout_probe, "build_report", return_value=layout),
            mock.patch.object(prep.preferred_webgpu, "PINNED_EXTERNAL_DATA_BYTES", source_bytes),
            mock.patch.object(prep.preferred_webgpu, "PINNED_EXTERNAL_DATA_SHA256", source_sha256),
            mock.patch.object(
                prep.preferred_cpu, "PINNED_PREFERRED_PAYLOAD_SHA256", payload_hashes
            ),
            mock.patch.object(prep.poststage_cpu, "EXPECTED_TIED_WEIGHT_BYTES", weight.nbytes),
            mock.patch.object(
                prep.poststage_cpu, "EXPECTED_FINAL_NORM_WEIGHT_OFFSET", weight.nbytes
            ),
            mock.patch.object(
                prep.poststage_cpu, "EXPECTED_FINAL_NORM_WEIGHT_BYTES", norm.nbytes
            ),
            mock.patch.object(
                prep,
                "EXPECTED_FINAL_NORM_WEIGHT_SHA256",
                hashlib.sha256(norm.tobytes(order="C")).hexdigest(),
            ),
        )

    def test_prepare_emits_complete_sequential_poststage_fixture(self) -> None:
        model, weight, norm = self._source_model()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_model = root / "model_q4.onnx"
            onnx.save_model(model, source_model)
            source_raw = weight.tobytes(order="C") + norm.tobytes(order="C")
            source_external = root / prep.poststage_cpu.EXPECTED_SOURCE_LOCATION
            source_external.write_bytes(source_raw)
            source_sha = hashlib.sha256(source_raw).hexdigest()
            candidate = layout_fixture._candidate(
                rows=self.ROWS,
                row_bytes=self.ROW_BYTES,
                source_offset_bytes=0,
                physical_count=4,
            )
            payload_hashes = {
                artifact["index"]: hashlib.sha256(
                    weight[
                        artifact["startRow"] : artifact["endRowExclusive"]
                    ].tobytes(order="C")
                ).hexdigest()
                for artifact in candidate["physicalArtifacts"]
            }
            layout = self._layout_report(
                source_graph_sha256=hashlib.sha256(source_model.read_bytes()).hexdigest(),
                source_bytes=len(source_raw),
                source_sha256=source_sha,
            )
            output = root / "out"
            patches = self._patches(
                layout=layout,
                weight=weight,
                norm=norm,
                source_bytes=len(source_raw),
                source_sha256=source_sha,
                payload_hashes=payload_hashes,
            )
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7]:
                report = prep.prepare(source_model, source_external, output)

            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["decisionStatus"], "diagnostic-only")
            self.assertEqual(len(report["physicalArtifacts"]), 4)
            self.assertEqual(len(report["tiles"]), 8)
            self.assertEqual(
                report["sequentialExecution"]["physicalArtifactOrder"], [0, 1, 2, 3]
            )
            self.assertEqual(
                report["sequentialExecution"]["tilesPerPhysicalArtifact"], 2
            )
            self.assertTrue((output / "final-norm.onnx").is_file())
            self.assertTrue((output / "reference-logits.f32").is_file())
            self.assertEqual((output / "reference-logits.f32").stat().st_size, self.ROWS * 4)
            self.assertEqual((output / "reference-final-norm.f32").stat().st_size, self.HIDDEN * 4)
            self.assertTrue(all((output / item["graph"]["file"]).is_file() for item in report["tiles"]))

    def test_tile_graph_rejects_multi_slice_geometry(self) -> None:
        tile = layout_fixture._candidate(
            rows=self.ROWS,
            row_bytes=self.ROW_BYTES,
            source_offset_bytes=0,
            physical_count=4,
        )["executionTiles"][0]
        mutated = dict(tile)
        mutated["physicalSlices"] = [dict(tile["physicalSlices"][0]), dict(tile["physicalSlices"][0])]
        with self.assertRaisesRegex(RuntimeError, "exactly one physical slice"):
            prep.build_tile_logits_model(
                tile=mutated, hidden_size=self.HIDDEN, payload_file="payload-0000.bin"
            )

    def test_final_norm_graph_requires_exact_weight_geometry(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "byte length mismatch"):
            prep.build_final_norm_model(
                hidden_size=self.HIDDEN,
                epsilon=prep.poststage_cpu.FINAL_NORM_EPSILON,
                weight_bytes=self.HIDDEN * 4 - 4,
            )

    def test_output_directory_must_be_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            (output / "existing.txt").write_text("x", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "must be empty"):
                prep._ensure_empty_output_dir(output)

    def test_layout_decision_promotion_fails_before_materialization(self) -> None:
        model, weight, norm = self._source_model()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_model = root / "model_q4.onnx"
            onnx.save_model(model, source_model)
            source_raw = weight.tobytes(order="C") + norm.tobytes(order="C")
            source_external = root / prep.poststage_cpu.EXPECTED_SOURCE_LOCATION
            source_external.write_bytes(source_raw)
            source_sha = hashlib.sha256(source_raw).hexdigest()
            layout = self._layout_report(
                source_graph_sha256=hashlib.sha256(source_model.read_bytes()).hexdigest(),
                source_bytes=len(source_raw),
                source_sha256=source_sha,
                decision_status="approved",
            )
            with (
                mock.patch.object(prep.layout_probe, "build_report", return_value=layout),
                self.assertRaisesRegex(RuntimeError, "must remain diagnostic-only"),
            ):
                prep.prepare(source_model, source_external, root / "out")


if __name__ == "__main__":
    unittest.main()
