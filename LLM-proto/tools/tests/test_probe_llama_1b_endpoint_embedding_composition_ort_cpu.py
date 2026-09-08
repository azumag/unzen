from __future__ import annotations
import sys
from pathlib import Path
import unittest

TOOLS=Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path: sys.path.insert(0,str(TOOLS))
import probe_llama_1b_endpoint_embedding_composition_ort_cpu as probe

class EndpointEmbeddingCompositionContractTest(unittest.TestCase):
    def test_token_ids_cover_every_execution_tile_and_boundaries(self) -> None:
        self.assertEqual(probe.TOKEN_IDS[0],0)
        self.assertEqual(probe.TOKEN_IDS[-1],probe.VOCAB_ROWS-1)
        tile_rows=probe.VOCAB_ROWS//8
        for tile in range(8):
            start=tile*tile_rows; end=(tile+1)*tile_rows-1
            self.assertIn(start,probe.TOKEN_IDS)
            self.assertIn(end,probe.TOKEN_IDS)

    def test_source_weight_geometry_is_exact_float32_vocab_matrix(self) -> None:
        self.assertEqual(probe.SOURCE_WEIGHT_BYTES, probe.VOCAB_ROWS*probe.HIDDEN_SIZE*probe.FLOAT32_BYTES)
        self.assertEqual(probe.SOURCE_WEIGHT_BYTES,1_050_673_152)

    def test_report_contract_remains_diagnostic_only(self) -> None:
        self.assertEqual(probe.REPORT_KIND,"unzen-pinned-llama-1b-endpoint-embedding-composition-ort-cpu-probe")
        self.assertEqual(probe.REPORT_SCHEMA_VERSION,"1.0.0")
        self.assertEqual(probe.PINNED_ORT_VERSION,"1.22.0")

if __name__=='__main__': unittest.main()
