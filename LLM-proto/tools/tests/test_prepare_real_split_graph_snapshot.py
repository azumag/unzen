from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_real_split as repack_module  # noqa: E402
import source_file_snapshot  # noqa: E402


class PrepareRealSplitGraphSnapshotTests(unittest.TestCase):
    @staticmethod
    def _model_without_external_data() -> mock.Mock:
        model = mock.Mock()
        model.graph.initializer = []
        return model

    def test_repack_parses_segment_graph_from_pinned_stream(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_path = root / "segment0.onnx"
            model_path.write_bytes(b"stable-graph-bytes")
            model = self._model_without_external_data()

            with mock.patch.object(
                repack_module.onnx,
                "load_model",
                return_value=model,
            ) as load_model:
                result = repack_module.repack_segment_external_data(
                    model_path,
                    root,
                    "segment0.onnx_data",
                )

            self.assertIsNone(result)
            load_model.assert_called_once()
            graph_input = load_model.call_args.args[0]
            self.assertFalse(isinstance(graph_input, (str, os.PathLike)))
            self.assertTrue(hasattr(graph_input, "read"))
            self.assertEqual(load_model.call_args.kwargs["load_external_data"], False)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO replacement requires POSIX mkfifo")
    def test_fifo_replacement_fails_before_graph_parse_or_output_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_path = root / "segment0.onnx"
            output_path = root / "segment0.onnx_data"
            model_path.write_bytes(b"graph")
            real_open = source_file_snapshot.os.open
            swapped = False

            def swap_then_open(
                name: os.PathLike[str] | str,
                flags: int,
                *args: object,
                **kwargs: object,
            ) -> int:
                nonlocal swapped
                if not swapped and Path(name) == model_path.resolve():
                    swapped = True
                    model_path.unlink()
                    os.mkfifo(model_path)
                    nonblock = getattr(os, "O_NONBLOCK", 0)
                    if nonblock:
                        self.assertTrue(flags & nonblock)
                return real_open(name, flags, *args, **kwargs)

            with (
                mock.patch.object(source_file_snapshot.os, "open", side_effect=swap_then_open),
                mock.patch.object(
                    repack_module.onnx,
                    "load_model",
                    side_effect=AssertionError("graph parser must not run"),
                ) as load_model,
            ):
                with self.assertRaisesRegex(RuntimeError, "regular file"):
                    repack_module.repack_segment_external_data(
                        model_path,
                        root,
                        output_path.name,
                    )

            self.assertTrue(swapped)
            load_model.assert_not_called()
            self.assertFalse(output_path.exists())

    def test_same_content_inode_replacement_fails_before_graph_parse(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_path = root / "segment0.onnx"
            replacement = root / "replacement.onnx"
            payload = b"same-content"
            model_path.write_bytes(payload)
            replacement.write_bytes(payload)
            real_open = source_file_snapshot.os.open
            swapped = False

            def swap_then_open(
                name: os.PathLike[str] | str,
                flags: int,
                *args: object,
                **kwargs: object,
            ) -> int:
                nonlocal swapped
                if not swapped and Path(name) == model_path.resolve():
                    swapped = True
                    model_path.unlink()
                    replacement.replace(model_path)
                return real_open(name, flags, *args, **kwargs)

            with (
                mock.patch.object(source_file_snapshot.os, "open", side_effect=swap_then_open),
                mock.patch.object(
                    repack_module.onnx,
                    "load_model",
                    side_effect=AssertionError("graph parser must not run"),
                ) as load_model,
            ):
                with self.assertRaisesRegex(RuntimeError, "changed between path check and open"):
                    repack_module.repack_segment_external_data(
                        model_path,
                        root,
                        "segment0.onnx_data",
                    )

            self.assertTrue(swapped)
            load_model.assert_not_called()

    def test_requested_symlink_retarget_fails_before_graph_parse(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_a = root / "segment-a.onnx"
            source_b = root / "segment-b.onnx"
            requested = root / "segment0.onnx"
            source_a.write_bytes(b"source-a")
            source_b.write_bytes(b"source-b")
            try:
                requested.symlink_to(source_a.name)
            except OSError as error:
                self.skipTest(f"symlink creation unavailable: {error}")

            real_verify = source_file_snapshot._verify_path_identity
            retargeted = False

            def retarget_then_verify(
                requested_path: Path,
                resolved: Path,
                opened: os.stat_result,
                *,
                label: str,
            ) -> None:
                nonlocal retargeted
                if not retargeted:
                    retargeted = True
                    requested_path.unlink()
                    requested_path.symlink_to(source_b.name)
                real_verify(requested_path, resolved, opened, label=label)

            with (
                mock.patch.object(
                    source_file_snapshot,
                    "_verify_path_identity",
                    side_effect=retarget_then_verify,
                ),
                mock.patch.object(
                    repack_module.onnx,
                    "load_model",
                    side_effect=AssertionError("graph parser must not run"),
                ) as load_model,
            ):
                with self.assertRaisesRegex(RuntimeError, "requested path changed"):
                    repack_module.repack_segment_external_data(
                        requested,
                        root,
                        "segment0.onnx_data",
                    )

            self.assertTrue(retargeted)
            load_model.assert_not_called()


if __name__ == "__main__":
    unittest.main()
