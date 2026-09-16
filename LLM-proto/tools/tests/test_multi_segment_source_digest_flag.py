from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import multi_segment_onnx as multi  # noqa: E402


class DirectSourceDigestFlagRuntimeBoundaryTest(unittest.TestCase):
    def test_rejects_non_boolean_before_source_read_or_output_creation(self) -> None:
        malformed_values = (None, 0, 1, "", "false", object())

        for value in malformed_values:
            with self.subTest(value=repr(value)), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                output = root / "split"
                with mock.patch.object(multi, "_read_source_graph_snapshot") as read:
                    with self.assertRaisesRegex(
                        ValueError,
                        r"hash_source_external_data must be a boolean",
                    ):
                        multi.prepare_budgeted_multi_split(
                            root / "missing.onnx",
                            output,
                            hidden_size=1,
                            target_bytes=1,
                            preferred_max_bytes=1,
                            hash_source_external_data=value,  # type: ignore[arg-type]
                        )

                read.assert_not_called()
                self.assertFalse(output.exists())

    def test_literal_booleans_pass_the_runtime_preflight(self) -> None:
        class SourceReadReached(RuntimeError):
            pass

        for value in (True, False):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source = root / "missing.onnx"
                output = root / "split"
                with mock.patch.object(
                    multi,
                    "_read_source_graph_snapshot",
                    side_effect=SourceReadReached,
                ) as read:
                    with self.assertRaises(SourceReadReached):
                        multi.prepare_budgeted_multi_split(
                            source,
                            output,
                            hidden_size=1,
                            target_bytes=1,
                            preferred_max_bytes=1,
                            hash_source_external_data=value,
                        )

                read.assert_called_once_with(source)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
