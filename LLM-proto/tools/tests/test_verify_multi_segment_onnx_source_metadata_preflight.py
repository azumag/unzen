from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import source_model_execution_snapshot as source_snapshot  # noqa: E402
from verify_multi_segment_onnx import verify_source_model_identity  # noqa: E402


class VerifySourceModelMetadataPreflightTest(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[Path, dict[str, object]]:
        source_payload = b"source-graph"
        source = root / "model.onnx"
        source.write_bytes(source_payload)

        external_entries: list[dict[str, object]] = []
        for index, payload in enumerate((b"weights-zero", b"weights-one")):
            path = root / f"model.onnx_data.{index}"
            path.write_bytes(payload)
            external_entries.append(
                {
                    "location": path.name,
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            )

        return source, {
            "sourceModel": {
                "sha256": hashlib.sha256(source_payload).hexdigest(),
                "externalData": external_entries,
            }
        }

    def _replace_with_hard_link(self, source: Path, destination: Path) -> None:
        destination.unlink()
        try:
            os.link(source, destination)
        except OSError as error:
            self.skipTest(f"hard links unavailable in test filesystem: {error}")

    def test_later_malformed_external_metadata_fails_before_any_payload_measurement(self) -> None:
        cases = [
            (
                "entry shape",
                lambda manifest: manifest["sourceModel"]["externalData"].__setitem__(1, "invalid"),
                r"externalData\[1\] must be an object",
            ),
            (
                "empty location",
                lambda manifest: manifest["sourceModel"]["externalData"][1].__setitem__("location", ""),
                r"externalData\[1\]\.location",
            ),
            (
                "unsafe location",
                lambda manifest: manifest["sourceModel"]["externalData"][1].__setitem__("location", "../outside.bin"),
                r"unsafe sourceModel\.externalData\[1\]\.location",
            ),
            (
                "repeated separator",
                lambda manifest: manifest["sourceModel"]["externalData"][1].__setitem__(
                    "location", "weights//outside.bin"
                ),
                r"unsafe sourceModel\.externalData\[1\]\.location",
            ),
            (
                "explicit dot component",
                lambda manifest: manifest["sourceModel"]["externalData"][1].__setitem__(
                    "location", "weights/./outside.bin"
                ),
                r"unsafe sourceModel\.externalData\[1\]\.location",
            ),
            (
                "trailing separator",
                lambda manifest: manifest["sourceModel"]["externalData"][1].__setitem__(
                    "location", "weights/"
                ),
                r"unsafe sourceModel\.externalData\[1\]\.location",
            ),
            (
                "control character",
                lambda manifest: manifest["sourceModel"]["externalData"][1].__setitem__(
                    "location", "weights\x1f.bin"
                ),
                r"unsafe sourceModel\.externalData\[1\]\.location",
            ),
            (
                "duplicate location",
                lambda manifest: manifest["sourceModel"]["externalData"][1].__setitem__(
                    "location",
                    manifest["sourceModel"]["externalData"][0]["location"],
                ),
                r"duplicate source external-data location",
            ),
            (
                "coercible bytes",
                lambda manifest: manifest["sourceModel"]["externalData"][1].__setitem__("bytes", "11"),
                r"externalData\[1\]\.bytes",
            ),
            (
                "missing digest",
                lambda manifest: manifest["sourceModel"]["externalData"][1].pop("sha256"),
                r"externalData\[1\]\.sha256 is required",
            ),
            (
                "non-canonical digest",
                lambda manifest: manifest["sourceModel"]["externalData"][1].__setitem__("sha256", "A" * 64),
                r"externalData\[1\]\.sha256 must be a canonical lowercase SHA-256 digest",
            ),
        ]

        for name, mutate, message in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                source, base_manifest = self._fixture(Path(tmp))
                manifest = deepcopy(base_manifest)
                mutate(manifest)
                with patch.object(source_snapshot, "_measure_file") as measure:
                    with self.assertRaisesRegex(ValueError, message):
                        verify_source_model_identity(source, manifest)
                measure.assert_not_called()

    def test_resolved_external_path_alias_fails_before_any_payload_measurement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, manifest = self._fixture(root)
            first = manifest["sourceModel"]["externalData"][0]
            second = manifest["sourceModel"]["externalData"][1]
            alias = root / "alias.bin"
            try:
                alias.symlink_to(str(first["location"]))
            except OSError as error:
                self.skipTest(f"symlinks unavailable in test filesystem: {error}")
            second["location"] = alias.name
            second["bytes"] = first["bytes"]
            second["sha256"] = first["sha256"]

            with patch.object(source_snapshot, "_measure_file") as measure:
                with self.assertRaisesRegex(
                    ValueError,
                    r"duplicate source external-data location: .* aliases .*",
                ):
                    verify_source_model_identity(source, manifest)
            measure.assert_not_called()

    def test_portable_case_alias_fails_before_source_filesystem_io(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source, manifest = self._fixture(Path(tmp))
            first = manifest["sourceModel"]["externalData"][0]
            second = manifest["sourceModel"]["externalData"][1]
            first["location"] = "weights/Chunk.bin"
            second["location"] = "weights/chunk.bin"

            with (
                patch.object(source_snapshot, "_source_file_identity") as identity,
                patch.object(source_snapshot, "_measure_file") as measure,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    r"portable case alias source external-data location",
                ):
                    verify_source_model_identity(source, manifest)
            identity.assert_not_called()
            measure.assert_not_called()

    def test_portable_separator_alias_fails_before_source_filesystem_io(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source, manifest = self._fixture(Path(tmp))
            first = manifest["sourceModel"]["externalData"][0]
            second = manifest["sourceModel"]["externalData"][1]
            first["location"] = "weights/chunk.bin"
            second["location"] = r"weights\chunk.bin"

            with (
                patch.object(source_snapshot, "_source_file_identity") as identity,
                patch.object(source_snapshot, "_measure_file") as measure,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    r"portable separator alias source external-data location",
                ):
                    verify_source_model_identity(source, manifest)
            identity.assert_not_called()
            measure.assert_not_called()

    def test_source_graph_path_alias_fails_before_any_payload_measurement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source, manifest = self._fixture(Path(tmp))
            graph_payload = source.read_bytes()
            external = manifest["sourceModel"]["externalData"][0]
            external["location"] = source.name
            external["bytes"] = len(graph_payload)
            external["sha256"] = hashlib.sha256(graph_payload).hexdigest()

            with patch.object(source_snapshot, "_measure_file") as measure:
                with self.assertRaisesRegex(
                    ValueError,
                    r"source external-data location aliases source graph path: model\.onnx",
                ):
                    verify_source_model_identity(source, manifest)
            measure.assert_not_called()

    def test_source_graph_hard_link_alias_fails_before_any_payload_measurement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, manifest = self._fixture(root)
            external = manifest["sourceModel"]["externalData"][0]
            external_path = root / str(external["location"])
            self._replace_with_hard_link(source, external_path)
            graph_payload = source.read_bytes()
            external["bytes"] = len(graph_payload)
            external["sha256"] = hashlib.sha256(graph_payload).hexdigest()

            with patch.object(source_snapshot, "_measure_file") as measure:
                with self.assertRaisesRegex(
                    ValueError,
                    r"source provenance hard-link alias: model\.onnx_data\.0 aliases source graph",
                ):
                    verify_source_model_identity(source, manifest)
            measure.assert_not_called()

    def test_external_hard_link_alias_fails_before_any_payload_measurement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, manifest = self._fixture(root)
            first = manifest["sourceModel"]["externalData"][0]
            second = manifest["sourceModel"]["externalData"][1]
            first_path = root / str(first["location"])
            second_path = root / str(second["location"])
            self._replace_with_hard_link(first_path, second_path)
            first_payload = first_path.read_bytes()
            second["bytes"] = len(first_payload)
            second["sha256"] = hashlib.sha256(first_payload).hexdigest()

            with patch.object(source_snapshot, "_measure_file") as measure:
                with self.assertRaisesRegex(
                    ValueError,
                    r"source provenance hard-link alias: model\.onnx_data\.1 aliases model\.onnx_data\.0",
                ):
                    verify_source_model_identity(source, manifest)
            measure.assert_not_called()

    def test_valid_nested_location_preserves_source_identity_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, manifest = self._fixture(root)
            entry = manifest["sourceModel"]["externalData"][0]
            original = root / str(entry["location"])
            nested_dir = root / "weights"
            nested_dir.mkdir()
            nested = nested_dir / original.name
            original.replace(nested)
            entry["location"] = f"weights/{nested.name}"

            report = verify_source_model_identity(source, manifest)

            self.assertEqual(report["externalData"], manifest["sourceModel"]["externalData"])
            self.assertIs(report["allExternalDataHashed"], True)

    def test_valid_metadata_preserves_source_identity_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source, manifest = self._fixture(Path(tmp))
            report = verify_source_model_identity(source, manifest)

            self.assertEqual(report["path"], str(source))
            self.assertEqual(report["graphBytes"], len(b"source-graph"))
            self.assertEqual(
                report["graphSha256"],
                hashlib.sha256(b"source-graph").hexdigest(),
            )
            self.assertEqual(report["externalData"], manifest["sourceModel"]["externalData"])
            self.assertIs(report["allExternalDataHashed"], True)

    def test_measured_external_mismatch_still_fails_closed_after_preflight(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, manifest = self._fixture(root)
            external = root / str(manifest["sourceModel"]["externalData"][1]["location"])
            external.write_bytes(b"changed-after-manifest")

            with self.assertRaisesRegex(ValueError, "source external-data size mismatch"):
                verify_source_model_identity(source, manifest)


if __name__ == "__main__":
    unittest.main()
