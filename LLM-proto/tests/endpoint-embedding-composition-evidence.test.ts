import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps the complete embedding composition evidence pinned and diagnostic-only', () => {
  const evidence = JSON.parse(readFileSync(
    new URL('../docs/evidence/endpoint-embedding-composition-ort-cpu-20260908.json', import.meta.url),
    'utf8',
  ));

  expect(evidence).toMatchObject({
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-embedding-composition-ort-cpu-probe',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    sourceGraphSha256: 'a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46',
    pinnedSourceExternalDataIdentity: {
      location: 'model_q4.onnx_data',
      bytes: 1_692_672_000,
      sha256: '07cc629ef2cb7fdb18615ce2e4f3774f763e6fc840207d772a8b511eead36647',
    },
    embeddingInitializer: {
      name: 'model.embed_tokens.weight',
      rows: 128_256,
      hiddenSize: 2_048,
      sourceOffset: 0,
      byteLength: 1_050_673_152,
    },
    onnxruntime: {
      version: '1.22.0',
      provider: 'CPUExecutionProvider',
    },
    comparison: {
      exactEqual: true,
      maxAbsDiff: 0,
      shape: [16, 2_048],
    },
  });

  const expectedTokenIds = [
    0, 16_031,
    16_032, 32_063,
    32_064, 48_095,
    48_096, 64_127,
    64_128, 80_159,
    80_160, 96_191,
    96_192, 112_223,
    112_224, 128_255,
  ];
  expect(evidence.tokenIds).toEqual(expectedTokenIds);
  expect(evidence.tileRuns).toHaveLength(8);

  for (let tileIndex = 0; tileIndex < 8; tileIndex += 1) {
    const tile = evidence.tileRuns[tileIndex];
    expect(tile).toMatchObject({
      tileIndex,
      physicalArtifactIndex: Math.floor(tileIndex / 2),
      positions: [tileIndex * 2, tileIndex * 2 + 1],
      localTokenIds: [0, 16_031],
    });
    expect(tile.globalTokenIds).toEqual(expectedTokenIds.slice(tileIndex * 2, tileIndex * 2 + 2));
    expect(tile.sessionCreateMs).toBeGreaterThan(0);
    expect(tile.runMs).toBeGreaterThan(0);
  }

  expect(evidence.conclusion).toContain('diagnostic-only');
  expect(evidence.conclusion).toContain('does not select the candidate layout');
});
