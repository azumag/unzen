from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import diagnose_multi_segment_budget as diagnostic  # noqa: E402
import multi_segment_onnx as planner  # noqa: E402


class BudgetDiagnosticSharedSnapshotTest(unittest.TestCase):
    def test_wrapper_delegates_capture_and_preserves_reported_requested_path(self) -> None:
        source = Path("relative") / "model.onnx"
        snapshot = b"shared-source-snapshot"
        digest = "a" * 64

        with mock.patch.object(
            diagnostic,
            "_read_shared_source_graph_snapshot",
            return_value=(snapshot, digest),
        ) as shared_reader:
            reported_path, observed, observed_digest = diagnostic._read_source_graph_snapshot(
                source,
                max_bytes=123,
            )

        shared_reader.assert_called_once_with(source, max_bytes=123)
        self.assertEqual(reported_path, source.expanduser().absolute())
        self.assertEqual(observed, snapshot)
        self.assertEqual(observed_digest, digest)

    def test_default_source_graph_limit_is_owned_by_planner_module(self) -> None:
        self.assertEqual(
            diagnostic.DEFAULT_SOURCE_GRAPH_MAX_BYTES,
            planner.DEFAULT_SOURCE_GRAPH_MAX_BYTES,
        )


if __name__ == "__main__":
    unittest.main()
