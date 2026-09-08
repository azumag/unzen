export const ENDPOINT_EMBEDDING_WEBGPU_EXPECTED = Object.freeze({
  manifestKind: 'unzen-pinned-llama-1b-endpoint-embedding-tiled-ort-webgpu-preparation',
  runtimeReportKind: 'unzen-pinned-llama-1b-endpoint-embedding-tiled-ort-webgpu-runtime',
  schemaVersion: '1.0.0',
  sourceGraphSha256: 'a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46',
  verifiedPinnedSourceGraph: {
    fileName: 'model_q4.onnx',
    byteLength: 149112,
    sha256: 'a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46',
    role: 'pinned-source-graph',
  },
  sourceExternalData: {
    fileName: 'model_q4.onnx_data',
    bytes: 1692672000,
    sha256: '07cc629ef2cb7fdb18615ce2e4f3774f763e6fc840207d772a8b511eead36647',
  },
  embeddingInitializer: {
    name: 'model.embed_tokens.weight',
    rows: 128256,
    hiddenSize: 2048,
    sourceOffsetBytes: 0,
    byteLength: 1050673152,
  },
  physicalArtifactCount: 4,
  executionTileCount: 8,
  rows: 128256,
  hiddenSize: 2048,
  onnxruntimeWebVersion: '1.22.0',
  graphExternalDataPath: 'payload-0000.bin',
  graphVariants: {
    offset0: {
      file: 'embedding-offset-0.onnx',
      artifactByteOffset: 0,
      bytes: 260,
      sha256: '70a56611e458eb6af8333329424756275aa5ad6b08467fa51912532867b6ce50',
    },
    offsetHalf: {
      file: 'embedding-offset-131334144.onnx',
      artifactByteOffset: 131334144,
      bytes: 268,
      sha256: 'bf43c241540197eb23e9d0768da23e4e81cbcdf80b145c93a91b5ee508b9d52a',
    },
  },
  physicalArtifacts: [
    { index: 0, file: 'payload-0000.bin', bytes: 262668288, sha256: 'b783704059e886b1e5438d23c3f9911b0d947c86125501c9071e5bb8f7cebdce', sourceOffsetBytes: 0, sourceEndOffsetBytesExclusive: 262668288 },
    { index: 1, file: 'payload-0001.bin', bytes: 262668288, sha256: '6725be963565c84faaf487339c9b6020166077d62ffeae36467ce284c49cafb7', sourceOffsetBytes: 262668288, sourceEndOffsetBytesExclusive: 525336576 },
    { index: 2, file: 'payload-0002.bin', bytes: 262668288, sha256: '21ea80f5829262b36028f32b17ef213090ff27ff708c6baa47277d45a99bff0a', sourceOffsetBytes: 525336576, sourceEndOffsetBytesExclusive: 788004864 },
    { index: 3, file: 'payload-0003.bin', bytes: 262668288, sha256: 'b2d23fbe273c8ae5f43c4ac4200613d3c88b0d11d389d2551a47af8649a688e9', sourceOffsetBytes: 788004864, sourceEndOffsetBytesExclusive: 1050673152 },
  ],
  tokenIds: [
    0, 16031, 16032, 32063, 32064, 48095, 48096, 64127,
    64128, 80159, 80160, 96191, 96192, 112223, 112224, 128255,
  ],
  tiles: Array.from({ length: 8 }, (_, tileIndex) => {
    const startRow = tileIndex * 16032;
    const endRowExclusive = startRow + 16032;
    return {
      tileIndex,
      startRow,
      endRowExclusive,
      rowCount: 16032,
      physicalArtifactIndex: Math.floor(tileIndex / 2),
      artifactByteOffset: tileIndex % 2 === 0 ? 0 : 131334144,
      byteLength: 131334144,
      graphVariant: tileIndex % 2 === 0 ? 'offset0' : 'offsetHalf',
      positions: [tileIndex * 2, tileIndex * 2 + 1],
      globalTokenIds: [startRow, endRowExclusive - 1],
      localTokenIds: [0, 16031],
    };
  }),
  sequentialExecution: {
    physicalArtifactOrder: [0, 1, 2, 3],
    tilesPerPhysicalArtifact: 2,
    maximumWholePhysicalPayloadBytesPerStep: 262668288,
    totalPhysicalPayloadBytesVerifiedAcrossRun: 1050673152,
  },
});

function requireEqual(actual, expected, field) {
  if (actual !== expected) throw new Error(`${field} contract mismatch`);
}

function requireExact(actual, expected, field) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${field} contract mismatch`);
  }
}

export function validateEndpointEmbeddingWebGpuManifest(manifest) {
  const expected = ENDPOINT_EMBEDDING_WEBGPU_EXPECTED;
  requireEqual(manifest?.kind, expected.manifestKind, 'manifest.kind');
  requireEqual(manifest?.runtimeReportKind, expected.runtimeReportKind, 'manifest.runtimeReportKind');
  requireEqual(manifest?.schemaVersion, expected.schemaVersion, 'manifest.schemaVersion');
  requireEqual(manifest?.status, 'pass', 'manifest.status');
  requireEqual(manifest?.decisionStatus, 'diagnostic-only', 'manifest.decisionStatus');
  for (const field of [
    'sourceGraphSha256', 'physicalArtifactCount', 'executionTileCount', 'rows',
    'hiddenSize', 'onnxruntimeWebVersion', 'graphExternalDataPath',
  ]) {
    requireEqual(manifest?.[field], expected[field], `manifest.${field}`);
  }
  requireExact(manifest?.verifiedPinnedSourceGraph, expected.verifiedPinnedSourceGraph, 'manifest.verifiedPinnedSourceGraph');
  requireExact(manifest?.sourceExternalData, expected.sourceExternalData, 'manifest.sourceExternalData');
  requireExact(manifest?.embeddingInitializer, expected.embeddingInitializer, 'manifest.embeddingInitializer');
  requireExact(manifest?.graphVariants, expected.graphVariants, 'manifest.graphVariants');
  requireExact(manifest?.physicalArtifacts, expected.physicalArtifacts, 'manifest.physicalArtifacts');
  requireExact(manifest?.tokenIds, expected.tokenIds, 'manifest.tokenIds');
  requireExact(manifest?.tiles, expected.tiles, 'manifest.tiles');
  requireExact(manifest?.sequentialExecution, expected.sequentialExecution, 'manifest.sequentialExecution');
  return manifest;
}
