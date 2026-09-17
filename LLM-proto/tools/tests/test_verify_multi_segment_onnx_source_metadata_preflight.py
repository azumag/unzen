from __future__ import annotations

import hashlib
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
                with patch("verify_multi_segment_onnx._measure_file") as measure:
                    with self.assertRaisesRegex(ValueError, message):
                        verify_source_model_identity(source, manifest)
                measure.assert_not_called()

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
