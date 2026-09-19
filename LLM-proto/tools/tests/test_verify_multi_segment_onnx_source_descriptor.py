from __future__ import annotations

import hashlib
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import source_model_execution_snapshot as source_snapshot  # noqa: E402
import verify_multi_segment_artifacts as artifact_verifier  # noqa: E402
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

    @unittest.skipUnless(hasattr(os, "symlink"), "requires symlink support")
    def test_stable_source_graph_symlink_remains_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"source-graph"
            target = root / "source-target.onnx"
            target.write_bytes(graph_payload)
            source = root / "model.onnx"
            source.symlink_to(target.name)
            manifest = self._manifest(graph_payload)

            report = verify_source_model_identity(source, manifest)

            self.assertEqual(report["path"], str(source))
            self.assertEqual(report["graphBytes"], len(graph_payload))
            self.assertEqual(
                report["graphSha256"],
                hashlib.sha256(graph_payload).hexdigest(),
            )

    @unittest.skipUnless(hasattr(os, "symlink"), "requires symlink support")
    def test_source_graph_symlink_retarget_before_measure_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"same-bytes"
            first = root / "first.onnx"
            second = root / "second.onnx"
            first.write_bytes(graph_payload)
            second.write_bytes(graph_payload)
            source = root / "model.onnx"
            source.symlink_to(first.name)
            manifest = self._manifest(graph_payload)
            real_measure = source_snapshot._measure_file
            retargeted = False

            def retarget_before_measure(path: Path, **kwargs: object) -> tuple[int, str]:
                nonlocal retargeted
                if not retargeted and Path(path) == source:
                    source.unlink()
                    source.symlink_to(second.name)
                    retargeted = True
                return real_measure(path, **kwargs)

            with mock.patch.object(
                source_snapshot,
                "_measure_file",
                side_effect=retarget_before_measure,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "artifact changed while being measured",
                ):
                    verify_source_model_identity(source, manifest)

            self.assertTrue(retargeted)

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

    @unittest.skipUnless(hasattr(os, "symlink"), "requires symlink support")
    def test_stable_source_external_symlink_remains_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"source-graph"
            external_payload = b"external-payload"
            source = root / "model.onnx"
            source.write_bytes(graph_payload)
            target = root / "payload.bin"
            target.write_bytes(external_payload)
            external = root / "model.onnx_data"
            external.symlink_to(target.name)
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

            report = verify_source_model_identity(source, manifest)

            self.assertEqual(report["externalData"], [
                {
                    "location": external.name,
                    "bytes": len(external_payload),
                    "sha256": hashlib.sha256(external_payload).hexdigest(),
                }
            ])

    @unittest.skipUnless(hasattr(os, "symlink"), "requires symlink support")
    def test_source_external_symlink_retarget_before_measure_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"source-graph"
            external_payload = b"same-bytes"
            source = root / "model.onnx"
            source.write_bytes(graph_payload)
            first = root / "first.bin"
            second = root / "second.bin"
            first.write_bytes(external_payload)
            second.write_bytes(external_payload)
            external = root / "model.onnx_data"
            external.symlink_to(first.name)
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
            real_measure = source_snapshot._measure_file
            calls = 0

            def retarget_before_measure(path: Path, **kwargs: object) -> tuple[int, str]:
                nonlocal calls
                calls += 1
                if calls == 2:
                    external.unlink()
                    external.symlink_to(second.name)
                return real_measure(path, **kwargs)

            with mock.patch.object(
                source_snapshot,
                "_measure_file",
                side_effect=retarget_before_measure,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "artifact changed while being measured",
                ):
                    verify_source_model_identity(source, manifest)

    @unittest.skipUnless(hasattr(os, "symlink"), "requires symlink support")
    def test_source_external_symlink_retarget_after_open_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph_payload = b"source-graph"
            external_payload = b"same-bytes"
            source = root / "model.onnx"
            source.write_bytes(graph_payload)
            first = root / "first.bin"
            second = root / "second.bin"
            first.write_bytes(external_payload)
            second.write_bytes(external_payload)
            external = root / "model.onnx_data"
            external.symlink_to(first.name)
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
            real_open = artifact_verifier.os.open
            first_resolved = first.resolve()
            retargeted = False

            def open_then_retarget(path: object, flags: int, *args: object, **kwargs: object) -> int:
                nonlocal retargeted
                fd = real_open(path, flags, *args, **kwargs)
                if not retargeted and Path(path) == first_resolved:
                    external.unlink()
                    external.symlink_to(second.name)
                    retargeted = True
                return fd

            with mock.patch.object(
                artifact_verifier.os,
                "open",
                side_effect=open_then_retarget,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "artifact changed while being measured",
                ):
                    verify_source_model_identity(source, manifest)

            self.assertTrue(retargeted)

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
