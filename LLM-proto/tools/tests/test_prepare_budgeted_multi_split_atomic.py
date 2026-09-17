from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import prepare_budgeted_multi_split_atomic as atomic  # noqa: E402


def make_manifest(*, external_data: bool, segment_count: int = 1) -> dict[str, object]:
    return {
        "sourceModel": {
            "path": "model.onnx",
            "externalData": [],
        },
        "segments": [
            {
                "index": index,
                "path": f"segment{index}.onnx",
                "externalData": (
                    [{"location": f"segment{index}.onnx_data"}]
                    if external_data
                    else []
                ),
            }
            for index in range(segment_count)
        ],
    }


def write_staged_split(staged: Path, *, external_data: bool) -> None:
    (staged / "segment0.onnx").write_bytes(b"new-graph")
    if external_data:
        (staged / "segment0.onnx_data").write_bytes(b"new-weights")
    (staged / "split-manifest.json").write_text("new-manifest\n", encoding="utf-8")


class PrepareBudgetedMultiSplitAtomicTest(unittest.TestCase):
    def test_success_invalidates_old_manifest_before_artifacts_and_publishes_new_manifest_last(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            staged = root / "staged"
            output = root / "output"
            staged.mkdir()
            output.mkdir()
            write_staged_split(staged, external_data=True)
            (output / "segment0.onnx").write_bytes(b"old-graph")
            (output / "segment0.onnx_data").write_bytes(b"old-weights")
            (output / "split-manifest.json").write_text("old-manifest\n", encoding="utf-8")

            real_replace = os.replace
            replacements: list[tuple[str, str]] = []

            def observing_replace(src: os.PathLike[str] | str, dst: os.PathLike[str] | str) -> None:
                src_path = Path(src)
                dst_path = Path(dst)
                if dst_path.name != "split-manifest.json":
                    self.assertFalse(
                        (output / "split-manifest.json").exists(),
                        "old manifest must be absent before the first artifact replacement",
                    )
                replacements.append((src_path.name, dst_path.name))
                real_replace(src, dst)

            with mock.patch.object(atomic.os, "replace", side_effect=observing_replace):
                atomic._publish_staged_split(
                    staged_dir=staged,
                    output_dir=output,
                    source_model_path=source,
                    manifest=make_manifest(external_data=True),
                )

            self.assertEqual(
                replacements,
                [
                    ("segment0.onnx", "segment0.onnx"),
                    ("segment0.onnx_data", "segment0.onnx_data"),
                    ("split-manifest.json", "split-manifest.json"),
                ],
            )
            self.assertEqual((output / "segment0.onnx").read_bytes(), b"new-graph")
            self.assertEqual((output / "segment0.onnx_data").read_bytes(), b"new-weights")
            self.assertEqual(
                (output / "split-manifest.json").read_text(encoding="utf-8"),
                "new-manifest\n",
            )

    def test_embedded_segment_removes_previous_external_data_before_manifest_publish(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            staged = root / "staged"
            output = root / "output"
            staged.mkdir()
            output.mkdir()
            write_staged_split(staged, external_data=False)
            (output / "segment0.onnx").write_bytes(b"old-graph")
            (output / "segment0.onnx_data").write_bytes(b"stale-weights")
            (output / "split-manifest.json").write_text("old-manifest\n", encoding="utf-8")

            atomic._publish_staged_split(
                staged_dir=staged,
                output_dir=output,
                source_model_path=source,
                manifest=make_manifest(external_data=False),
            )

            self.assertEqual((output / "segment0.onnx").read_bytes(), b"new-graph")
            self.assertFalse((output / "segment0.onnx_data").exists())
            self.assertEqual(
                (output / "split-manifest.json").read_text(encoding="utf-8"),
                "new-manifest\n",
            )

    def test_shrinking_segment_count_prunes_previous_tail_before_new_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            staged = root / "staged"
            output = root / "output"
            staged.mkdir()
            output.mkdir()
            write_staged_split(staged, external_data=True)
            for index in range(3):
                (output / f"segment{index}.onnx").write_bytes(f"old-graph-{index}".encode())
                (output / f"segment{index}.onnx_data").write_bytes(
                    f"old-weights-{index}".encode()
                )
            previous_manifest = make_manifest(external_data=True, segment_count=3)
            (output / "split-manifest.json").write_text(
                json.dumps(previous_manifest) + "\n",
                encoding="utf-8",
            )
            unrelated = output / "notes.txt"
            unrelated.write_text("keep me\n", encoding="utf-8")

            real_replace = os.replace

            def observing_replace(src: os.PathLike[str] | str, dst: os.PathLike[str] | str) -> None:
                dst_path = Path(dst)
                if dst_path.name == "split-manifest.json":
                    for index in (1, 2):
                        self.assertFalse((output / f"segment{index}.onnx").exists())
                        self.assertFalse((output / f"segment{index}.onnx_data").exists())
                real_replace(src, dst)

            with mock.patch.object(atomic.os, "replace", side_effect=observing_replace):
                atomic._publish_staged_split(
                    staged_dir=staged,
                    output_dir=output,
                    source_model_path=source,
                    manifest=make_manifest(external_data=True),
                )

            self.assertEqual((output / "segment0.onnx").read_bytes(), b"new-graph")
            self.assertEqual((output / "segment0.onnx_data").read_bytes(), b"new-weights")
            for index in (1, 2):
                self.assertFalse((output / f"segment{index}.onnx").exists())
                self.assertFalse((output / f"segment{index}.onnx_data").exists())
            self.assertEqual(unrelated.read_text(encoding="utf-8"), "keep me\n")

    def test_unsafe_previous_tail_is_rejected_before_old_manifest_invalidation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            staged = root / "staged"
            output = root / "output"
            staged.mkdir()
            output.mkdir()
            write_staged_split(staged, external_data=True)
            (output / "segment0.onnx").write_bytes(b"old-graph")
            (output / "segment0.onnx_data").write_bytes(b"old-weights")
            outside = root / "outside.bin"
            outside.write_bytes(b"outside")
            (output / "segment1.onnx").symlink_to(outside)
            previous_manifest = make_manifest(external_data=True, segment_count=2)
            previous_text = json.dumps(previous_manifest) + "\n"
            (output / "split-manifest.json").write_text(previous_text, encoding="utf-8")

            with self.assertRaisesRegex(ValueError, r"must not be a symlink"):
                atomic._publish_staged_split(
                    staged_dir=staged,
                    output_dir=output,
                    source_model_path=source,
                    manifest=make_manifest(external_data=True),
                )

            self.assertEqual(
                (output / "split-manifest.json").read_text(encoding="utf-8"),
                previous_text,
            )
            self.assertTrue((output / "segment1.onnx").is_symlink())
            self.assertEqual(outside.read_bytes(), b"outside")

    def test_publish_failure_leaves_manifest_absent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            staged = root / "staged"
            output = root / "output"
            staged.mkdir()
            output.mkdir()
            write_staged_split(staged, external_data=True)
            (output / "segment0.onnx").write_bytes(b"old-graph")
            (output / "segment0.onnx_data").write_bytes(b"old-weights")
            (output / "split-manifest.json").write_text("old-manifest\n", encoding="utf-8")

            with mock.patch.object(
                atomic.os,
                "replace",
                side_effect=OSError("simulated publish failure"),
            ):
                with self.assertRaisesRegex(OSError, "simulated publish failure"):
                    atomic._publish_staged_split(
                        staged_dir=staged,
                        output_dir=output,
                        source_model_path=source,
                        manifest=make_manifest(external_data=True),
                    )

            self.assertFalse((output / "split-manifest.json").exists())
            self.assertEqual((output / "segment0.onnx").read_bytes(), b"old-graph")
            self.assertEqual((output / "segment0.onnx_data").read_bytes(), b"old-weights")

    def test_staging_failure_preserves_previously_published_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"
            source.write_bytes(b"source")
            output = root / "output"
            output.mkdir()
            (output / "segment0.onnx").write_bytes(b"old-graph")
            (output / "split-manifest.json").write_text("old-manifest\n", encoding="utf-8")

            with mock.patch.object(
                atomic,
                "prepare_budgeted_multi_split",
                side_effect=RuntimeError("simulated generation failure"),
            ):
                with self.assertRaisesRegex(RuntimeError, "simulated generation failure"):
                    atomic.prepare_budgeted_multi_split_atomic(
                        source,
                        output,
                        target_bytes=1,
                        preferred_max_bytes=1,
                    )

            self.assertEqual((output / "segment0.onnx").read_bytes(), b"old-graph")
            self.assertEqual(
                (output / "split-manifest.json").read_text(encoding="utf-8"),
                "old-manifest\n",
            )
            self.assertFalse(
                any(path.name.startswith(".unzen-budgeted-split-stage-") for path in output.iterdir())
            )

    def test_invalid_options_fail_before_output_or_staging_side_effects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "not-created"
            defaults: dict[str, object] = {
                "hidden_size": 2048,
                "target_bytes": 1,
                "preferred_max_bytes": 1,
            }

            with mock.patch.object(atomic, "prepare_budgeted_multi_split") as generator:
                for name in defaults:
                    options = dict(defaults)
                    options[name] = True
                    with self.subTest(name=name):
                        with self.assertRaisesRegex(
                            ValueError,
                            rf"{name} must be a positive integer",
                        ):
                            atomic.prepare_budgeted_multi_split_atomic(
                                root / "missing.onnx",
                                output,
                                **options,  # type: ignore[arg-type]
                            )
                        generator.assert_not_called()
                        self.assertFalse(output.exists())

    def test_source_digest_flag_rejects_non_booleans_before_side_effects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "not-created"
            malformed = (None, 0, 1, "", "false", object())

            with mock.patch.object(atomic, "prepare_budgeted_multi_split") as generator:
                for value in malformed:
                    with self.subTest(value=repr(value)):
                        with self.assertRaisesRegex(
                            ValueError,
                            r"hash_source_external_data must be a boolean",
                        ):
                            atomic.prepare_budgeted_multi_split_atomic(
                                root / "missing.onnx",
                                output,
                                target_bytes=1,
                                preferred_max_bytes=1,
                                hash_source_external_data=value,  # type: ignore[arg-type]
                            )
                        generator.assert_not_called()
                        self.assertFalse(output.exists())

    def test_source_digest_flag_preserves_literal_boolean_semantics(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "model.onnx"

            for value in (True, False):
                output = root / f"output-{value}"
                with self.subTest(value=value), mock.patch.object(
                    atomic,
                    "prepare_budgeted_multi_split",
                    return_value=make_manifest(external_data=False),
                ) as generator, mock.patch.object(atomic, "_publish_staged_split"):
                    atomic.prepare_budgeted_multi_split_atomic(
                        source,
                        output,
                        target_bytes=1,
                        preferred_max_bytes=1,
                        hash_source_external_data=value,
                    )
                    self.assertIs(generator.call_args.kwargs["hash_source_external_data"], value)


if __name__ == "__main__":
    unittest.main()
