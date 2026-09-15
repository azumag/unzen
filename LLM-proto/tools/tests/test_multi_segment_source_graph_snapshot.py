from __future__ import annotations

import hashlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import multi_segment_onnx as target


class SourceGraphSnapshotTests(unittest.TestCase):
    def test_snapshot_returns_exact_bytes_and_digest(self) -> None:
        payload = b"stable-source-graph\x00bytes"
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "model.onnx"
            path.write_bytes(payload)

            raw, digest = target._read_source_graph_snapshot(path)

        self.assertEqual(raw, payload)
        self.assertEqual(digest, hashlib.sha256(payload).hexdigest())

    def test_stable_symlink_keeps_existing_path_semantics(self) -> None:
        if not hasattr(os, "symlink"):
            self.skipTest("symlink is unavailable")
        payload = b"symlinked-source-graph"
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            real = root / "real.onnx"
            requested = root / "requested.onnx"
            real.write_bytes(payload)
            try:
                requested.symlink_to(real.name)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error}")

            raw, digest = target._read_source_graph_snapshot(requested)

        self.assertEqual(raw, payload)
        self.assertEqual(digest, hashlib.sha256(payload).hexdigest())

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO requires POSIX mkfifo")
    def test_fifo_is_rejected_before_blocking_open(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "model.onnx"
            os.mkfifo(path)

            with self.assertRaisesRegex(RuntimeError, "regular file"):
                target._read_source_graph_snapshot(path)

    def test_path_replacement_between_check_and_open_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            path = root / "model.onnx"
            replacement = root / "replacement.onnx"
            path.write_bytes(b"original")
            replacement.write_bytes(b"replacement")
            real_open = os.open
            replaced = False

            def replace_then_open(name: os.PathLike[str] | str, flags: int, *args: object) -> int:
                nonlocal replaced
                if not replaced:
                    replaced = True
                    os.replace(replacement, path)
                return real_open(name, flags, *args)

            with patch.object(target.os, "open", side_effect=replace_then_open):
                with self.assertRaisesRegex(RuntimeError, "between path check and open"):
                    target._read_source_graph_snapshot(path)

    def test_read_time_growth_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            path = Path(raw_dir) / "model.onnx"
            path.write_bytes(b"a" * 4096)
            real_read = os.read
            mutated = False

            def mutate_after_read(fd: int, size: int) -> bytes:
                nonlocal mutated
                block = real_read(fd, size)
                if block and not mutated:
                    mutated = True
                    with path.open("ab") as stream:
                        stream.write(b"growth")
                return block

            with patch.object(target.os, "read", side_effect=mutate_after_read):
                with self.assertRaisesRegex(RuntimeError, "changed while being read"):
                    target._read_source_graph_snapshot(path)

    def test_prepare_parses_and_records_the_same_snapshot(self) -> None:
        captured = b"captured-source-graph"
        captured_digest = hashlib.sha256(captured).hexdigest()
        fake_model = object()
        fake_segment = SimpleNamespace(graph=SimpleNamespace(input=[], output=[]))
        spec = target.SegmentSpec(
            start_layer=0,
            end_layer=1,
            output_names=("logits",),
            extra_input_names=(),
        )

        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            source = root / "model.onnx"
            output = root / "out"
            source.write_bytes(b"pathname-bytes-must-not-be-reopened")

            def save_segment(_segment: object, path: str) -> None:
                Path(path).write_bytes(b"segment")

            def apply_budget(manifest: dict[str, object], *_args: object, **_kwargs: object) -> None:
                segments = manifest["segments"]
                assert isinstance(segments, list)
                assert isinstance(segments[0], dict)
                segments[0]["browserArtifactBytes"] = 1

            with (
                patch.object(
                    target,
                    "_read_source_graph_snapshot",
                    return_value=(captured, captured_digest),
                ) as read_snapshot,
                patch.object(target.onnx, "load_model", return_value=fake_model) as load_model,
                patch.object(target, "_source_external_manifest", return_value=[]),
                patch.object(target, "plan_layer_spans", return_value=((), (1,))),
                patch.object(target, "build_segment_specs", return_value=(spec,)),
                patch.object(target, "extract_submodel", return_value=fake_segment),
                patch.object(target.onnx, "save_model", side_effect=save_segment),
                patch.object(target, "repack_segment_external_data", return_value=None),
                patch.object(target, "check_model_for_runtime"),
                patch.object(target, "sha256_file", return_value="segment-digest") as sha256_file,
                patch.object(target, "apply_browser_budget", side_effect=apply_budget),
            ):
                manifest = target.prepare_budgeted_multi_split(
                    source,
                    output,
                    target_bytes=1,
                    preferred_max_bytes=1,
                )

        read_snapshot.assert_called_once_with(source)
        load_model.assert_called_once()
        parsed_source = load_model.call_args.args[0]
        self.assertIsInstance(parsed_source, io.BytesIO)
        self.assertEqual(parsed_source.getvalue(), captured)
        self.assertFalse(load_model.call_args.kwargs["load_external_data"])
        self.assertEqual(manifest["sourceModel"]["sha256"], captured_digest)
        sha256_file.assert_called_once_with(output / "segment0.onnx")


if __name__ == "__main__":
    unittest.main()
