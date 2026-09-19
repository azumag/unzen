from __future__ import annotations

from pathlib import Path
import sys
import unittest


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import source_model_execution_snapshot as shared_snapshot  # noqa: E402
import verify_multi_segment_kv_decode as kv_verifier  # noqa: E402
import verify_multi_segment_onnx as multi_verifier  # noqa: E402


class SourceModelExecutionSnapshotConsumersTest(unittest.TestCase):
    def test_multi_segment_verifier_reexports_shared_snapshot_boundary(self) -> None:
        self.assertIs(
            multi_verifier._verified_source_execution_snapshot,
            shared_snapshot.verified_source_execution_snapshot,
        )
        self.assertIs(
            multi_verifier.verify_source_model_identity,
            shared_snapshot.verify_source_model_identity,
        )

    def test_kv_verifier_resolves_to_same_shared_snapshot_boundary(self) -> None:
        self.assertIs(
            kv_verifier._verified_source_execution_snapshot,
            shared_snapshot.verified_source_execution_snapshot,
        )

    def test_shared_helper_remains_verifier_neutral(self) -> None:
        self.assertNotIn("verify_split_onnx", shared_snapshot.__dict__)
        self.assertNotIn("verify_multi_segment_onnx", shared_snapshot.__dict__)
        self.assertNotIn("verify_multi_segment_kv_decode", shared_snapshot.__dict__)


if __name__ == "__main__":
    unittest.main()
