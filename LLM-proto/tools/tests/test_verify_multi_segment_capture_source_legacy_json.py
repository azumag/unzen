from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import verify_multi_segment_capture_source as source_module  # noqa: E402


class VerifyMultiSegmentCaptureSourceLegacyJsonTest(unittest.TestCase):
    def test_projects_existing_stable_reader_snapshot(self) -> None:
        path = Path("control.json")
        payload = {"status": "pass"}

        with patch.object(
            source_module,
            "_stable_json_object",
            return_value=(payload, "0" * 64),
        ) as stable_reader:
            observed = source_module._json_object(path, field="control evidence")

        self.assertIs(observed, payload)
        stable_reader.assert_called_once_with(path, field="control evidence")

    def test_rejects_non_regular_input_through_stable_reader(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "control.json"
            directory.mkdir()

            with self.assertRaisesRegex(ValueError, "must be a regular file"):
                source_module._json_object(directory, field="control evidence")

    def test_rejects_malformed_json_through_stable_reader(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "control.json"
            path.write_text("{not-json", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "is not valid JSON"):
                source_module._json_object(path, field="control evidence")


if __name__ == "__main__":
    unittest.main()
