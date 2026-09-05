from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from verify_multi_segment_artifacts import verify_artifact_integrity  # noqa: E402


class VerifyMultiSegmentArtifactsTest(unittest.TestCase):
    def _sha(self, payload: bytes) -> str:
        return hashlib.sha256(payload).hexdigest()

    def _fixture(self, root: Path, *, required_max_bytes: int = 1024) -> Path:
        graph_payloads = [b"graph-zero", b"graph-one"]
        external_payloads = [b"weights-zero", b"weights-one"]
        segments = []
        budget_segments = []
        maximum = 0

        for index, (graph_payload, external_payload) in enumerate(
            zip(graph_payloads, external_payloads, strict=True)
        ):
            graph_name = f"segment{index}.onnx"
            external_name = f"segment{index}.onnx_data"
            (root / graph_name).write_bytes(graph_payload)
            (root / external_name).write_bytes(external_payload)
            artifact_bytes = len(graph_payload) + len(external_payload)
            maximum = max(maximum, artifact_bytes)
            segments.append(
                {
                    "index": index,
                    "path": graph_name,
                    "sha256": self._sha(graph_payload),
                    "browserArtifactBytes": artifact_bytes,
                    "browserArtifactTier": "preferred",
                    "externalData": [
                        {
                            "location": external_name,
                            "bytes": len(external_payload),
                            "sha256": self._sha(external_payload),
                        }
                    ],
                }
            )
            budget_segments.append(
                {
                    "index": index,
                    "artifactBytes": artifact_bytes,
                    "tier": "preferred",
                }
            )

        manifest = {
            "schemaVersion": "1.0.0",
            "kind": "unzen-budgeted-multi-segment-onnx",
            "artifactLayout": "per-segment-external-data",
            "splitPlan": {
                "requiredMaxBytes": required_max_bytes,
                "maximumGeneratedSegmentBytes": maximum,
            },
            "browserArtifactBudget": {
                "preferredMaxBytes": 512,
                "normalMaxBytes": 1024,
                "absoluteMaxBytes": 2048,
                "requiredMaxBytes": 512,
                "maximumSegmentArtifactBytes": maximum,
                "segments": budget_segments,
            },
            "segments": segments,
        }
        path = root / "split-manifest.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return path

    def _load_manifest(self, path: Path) -> dict[str, object]:
        return json.loads(path.read_text(encoding="utf-8"))

    def _save_manifest(self, path: Path, manifest: dict[str, object]) -> None:
        path.write_text(json.dumps(manifest), encoding="utf-8")

    def test_valid_artifacts_report_measured_bytes_and_digests(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = self._fixture(Path(tmp))

            report = verify_artifact_integrity(manifest_path)

            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["segmentCount"], 2)
            self.assertEqual(report["effectiveRequiredMaxBytes"], 512)
            self.assertEqual(len(report["manifestSha256"]), 64)
            for segment in report["segments"]:
                self.assertEqual(
                    segment["artifactBytes"],
                    segment["graphBytes"] + segment["externalBytes"],
                )
                self.assertEqual(segment["tier"], "preferred")
                self.assertEqual(len(segment["graphSha256"]), 64)

    def test_rejects_graph_modified_after_manifest_generation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            (root / "segment0.onnx").write_bytes(b"tampered-graph")

            with self.assertRaisesRegex(ValueError, "graph SHA-256 mismatch"):
                verify_artifact_integrity(manifest_path)

    def test_rejects_truncated_or_extended_external_data(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            (root / "segment1.onnx_data").write_bytes(b"different-size")

            with self.assertRaisesRegex(ValueError, "external-data size mismatch"):
                verify_artifact_integrity(manifest_path)

    def test_rejects_manifest_byte_count_that_no_longer_matches_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            manifest["segments"][0]["browserArtifactBytes"] += 1
            self._save_manifest(manifest_path, manifest)

            with self.assertRaisesRegex(ValueError, "browserArtifactBytes mismatch"):
                verify_artifact_integrity(manifest_path)

    def test_rejects_coercible_manifest_integer_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            external_bytes = manifest["segments"][0]["externalData"][0]["bytes"]
            manifest["segments"][0]["externalData"][0]["bytes"] = str(external_bytes)
            self._save_manifest(manifest_path, manifest)
            with self.subTest(field="externalData.bytes numeric string"):
                with self.assertRaisesRegex(ValueError, "must be a non-negative integer"):
                    verify_artifact_integrity(manifest_path)

            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            artifact_bytes = manifest["segments"][0]["browserArtifactBytes"]
            manifest["segments"][0]["browserArtifactBytes"] = float(artifact_bytes)
            self._save_manifest(manifest_path, manifest)
            with self.subTest(field="browserArtifactBytes float"):
                with self.assertRaisesRegex(ValueError, "must be a non-negative integer"):
                    verify_artifact_integrity(manifest_path)

            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            manifest["browserArtifactBudget"]["requiredMaxBytes"] = 512.0
            self._save_manifest(manifest_path, manifest)
            with self.subTest(field="requiredMaxBytes float"):
                with self.assertRaisesRegex(ValueError, "must be a positive integer"):
                    verify_artifact_integrity(manifest_path)

            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            manifest["segments"][0]["index"] = 0.0
            self._save_manifest(manifest_path, manifest)
            with self.subTest(field="segment index float"):
                with self.assertRaisesRegex(ValueError, "must be a non-negative integer"):
                    verify_artifact_integrity(manifest_path)

    def test_rejects_coercible_manifest_string_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            manifest["segments"][0]["path"] = 123
            self._save_manifest(manifest_path, manifest)
            with self.subTest(field="segment path number"):
                with self.assertRaisesRegex(ValueError, "must be a non-empty string"):
                    verify_artifact_integrity(manifest_path)

            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            manifest["segments"][0]["sha256"] = int("1" * 64)
            self._save_manifest(manifest_path, manifest)
            with self.subTest(field="segment sha256 number"):
                with self.assertRaisesRegex(ValueError, "must be a non-empty string"):
                    verify_artifact_integrity(manifest_path)

            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            manifest["segments"][0]["externalData"][0]["location"] = True
            self._save_manifest(manifest_path, manifest)
            with self.subTest(field="external-data location boolean"):
                with self.assertRaisesRegex(ValueError, "must be a non-empty string"):
                    verify_artifact_integrity(manifest_path)

            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            manifest["segments"][0]["browserArtifactTier"] = True
            self._save_manifest(manifest_path, manifest)
            with self.subTest(field="segment tier boolean"):
                with self.assertRaisesRegex(ValueError, "must be a non-empty string"):
                    verify_artifact_integrity(manifest_path)

            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            manifest["browserArtifactBudget"]["segments"][0]["tier"] = 1
            self._save_manifest(manifest_path, manifest)
            with self.subTest(field="budget tier number"):
                with self.assertRaisesRegex(ValueError, "must be a non-empty string"):
                    verify_artifact_integrity(manifest_path)

    def test_rejects_unknown_manifest_schema_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            manifest["schemaVersion"] = "2.0.0"
            self._save_manifest(manifest_path, manifest)

            with self.assertRaisesRegex(ValueError, "unexpected split manifest schemaVersion"):
                verify_artifact_integrity(manifest_path)

    def test_enforces_stricter_split_plan_budget_against_observed_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            manifest["splitPlan"]["requiredMaxBytes"] = 1
            self._save_manifest(manifest_path, manifest)

            with self.assertRaisesRegex(RuntimeError, "exceeds effective required"):
                verify_artifact_integrity(manifest_path)

    def test_rejects_external_data_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = self._fixture(root)
            manifest = self._load_manifest(manifest_path)
            manifest["segments"][0]["externalData"][0]["location"] = "../weights.bin"
            self._save_manifest(manifest_path, manifest)

            with self.assertRaisesRegex(ValueError, "unsafe .*location"):
                verify_artifact_integrity(manifest_path)


if __name__ == "__main__":
    unittest.main()
