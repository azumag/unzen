from __future__ import annotations

import hashlib
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from verify_multi_segment_onnx import verify_source_model_identity  # noqa: E402


class VerifyMultiSegmentOnnxSourceDescriptorTest(unittest.TestCase):
    @staticmethod
    def _manifest(
        graph_payload: bytes,
        *,
        external: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        return {
            "sourceModel": {
                "sha256": hashlib.sha256(graph_payload).hexdigest(),
                "externalData": external or [],
            }
        }

    def test_missing_source_graph_preserves_domain_diagnostic(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "missing-model.onnx"
            manifest = self._manifest(b"not-present")

            with self.assertRaisesRegex(
                FileNotFoundError,
                re.escape(f"full model not found: {source}"),
            ):
                verify_source_model_identity(source, manifest)

    def test_missing_source_external_data_preserves_domain_diagnostic(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"source-graph"
            source = root / "model.onnx"
            source.write_bytes(graph_payload)
            external = root / "missing-model.onnx_data"
            external_payload = b"not-present"
            manifest = self._manifest(
                graph_payload,
                external=[
                    {
                        "location": external.name,
                        "bytes": len(external_payload),
                        "sha256": hashlib.sha256(external_payload).hexdigest(),
                    }
                ],
            )

            with self.assertRaisesRegex(
                FileNotFoundError,
                re.escape(f"source external data not found: {external}"),
            ):
                verify_source_model_identity(source, manifest)

    @unittest.skipUnless(
        hasattr(os, "mkfifo") and hasattr(os, "O_NONBLOCK"),
        "requires POSIX FIFO support",
    )
    def test_source_graph_fifo_fails_closed_before_reading(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "model.onnx"
            os.mkfifo(source)
            manifest = self._manifest(b"")

            with self.assertRaisesRegex(ValueError, "artifact must be a regular file"):
                verify_source_model_identity(source, manifest)

    @unittest.skipUnless(
        hasattr(os, "mkfifo") and hasattr(os, "O_NONBLOCK"),
        "requires POSIX FIFO support",
    )
    def test_source_external_fifo_fails_closed_before_reading(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"source-graph"
            source = root / "model.onnx"
            source.write_bytes(graph_payload)
            external = root / "model.onnx_data"
            os.mkfifo(external)
            manifest = self._manifest(
                graph_payload,
                external=[
                    {
                        "location": external.name,
                        "bytes": 0,
                        "sha256": hashlib.sha256(b"").hexdigest(),
                    }
                ],
            )

            with self.assertRaisesRegex(ValueError, "artifact must be a regular file"):
                verify_source_model_identity(source, manifest)


if __name__ == "__main__":
    unittest.main()
