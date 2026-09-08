export const ENDPOINT_FIVE_WAY_WEBGPU_EXPECTED = Object.freeze({
  manifestKind: 'unzen-pinned-llama-1b-endpoint-five-way-tile-ort-webgpu-preparation',
  schemaVersion: '1.0.0',
  sourceGraphSha256: 'a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46',
  sourceExternalBytes: 1692672000,
  sourceExternalSha256: '07cc629ef2cb7fdb18615ce2e4f3774f763e6fc840207d772a8b511eead36647',
  hiddenSize: 2048,
  physicalArtifactCount: 5,
  executionTileCount: 8,
  selectedTileIndex: 1,
  onnxruntimeWebVersion: '1.22.0',
  physicalArtifacts: [
    { index: 0, file: 'payload-0000.bin', bytes: 210141184, sha256: '3e7e1625498180fc107d572f65bfbb57fef091002fd05990c693b338e2d8edbe', sourceOffsetBytes: 0, sourceEndOffsetBytesExclusive: 210141184 },
    { index: 1, file: 'payload-0001.bin', bytes: 210132992, sha256: 'b1dd6fe5c5668e8e63e597a6cbe6629093dd724b34d82b89ea9715566db93adf', sourceOffsetBytes: 210141184, sourceEndOffsetBytesExclusive: 420274176 },
  ],
  tile: {
    tileIndex: 1,
    startRow: 16032,
    endRowExclusive: 32064,
    rowCount: 16032,
    byteLength: 131334144,
    physicalSlices: [
      { physicalArtifactIndex: 0, startRow: 16032, endRowExclusive: 25652, rowCount: 9620, artifactByteOffset: 131334144, byteLength: 78807040 },
      { physicalArtifactIndex: 1, startRow: 25652, endRowExclusive: 32064, rowCount: 6412, artifactByteOffset: 0, byteLength: 52527104 },
    ],
    graphs: {
      embedding: { file: 'tile-1-embedding.onnx', bytes: 458, sha256: '766fe54ec27097847b46d1de5d27912267742fc819e1dff96b1461d81d2065c2' },
      logits: { file: 'tile-1-logits.onnx', bytes: 525, sha256: 'f879f97d991b11c1d44a407fe9d7cba2c8da5e3c82d2e138c9ee7d48000db1ab' },
    },
  },
});

function requireEqual(actual, expected, field) {
  if (actual !== expected) throw new Error(`${field} contract mismatch`);
}

export function validateEndpointFiveWayWebGpuManifest(manifest) {
  const expected = ENDPOINT_FIVE_WAY_WEBGPU_EXPECTED;
  requireEqual(manifest?.kind, expected.manifestKind, 'manifest.kind');
  requireEqual(manifest?.schemaVersion, expected.schemaVersion, 'manifest.schemaVersion');
  requireEqual(manifest?.status, 'pass', 'manifest.status');
  requireEqual(manifest?.decisionStatus, 'diagnostic-only', 'manifest.decisionStatus');
  requireEqual(manifest?.sourceGraphSha256, expected.sourceGraphSha256, 'manifest.sourceGraphSha256');
  requireEqual(manifest?.sourceExternalData?.bytes, expected.sourceExternalBytes, 'manifest.sourceExternalData.bytes');
  requireEqual(manifest?.sourceExternalData?.sha256, expected.sourceExternalSha256, 'manifest.sourceExternalData.sha256');
  requireEqual(manifest?.physicalArtifactCount, expected.physicalArtifactCount, 'manifest.physicalArtifactCount');
  requireEqual(manifest?.executionTileCount, expected.executionTileCount, 'manifest.executionTileCount');
  requireEqual(manifest?.selectedTileIndex, expected.selectedTileIndex, 'manifest.selectedTileIndex');
  requireEqual(manifest?.hiddenSize, expected.hiddenSize, 'manifest.hiddenSize');
  requireEqual(manifest?.onnxruntimeWebVersion, expected.onnxruntimeWebVersion, 'manifest.onnxruntimeWebVersion');
  if (!Array.isArray(manifest?.physicalArtifacts) || manifest.physicalArtifacts.length !== expected.physicalArtifacts.length) {
    throw new Error('manifest.physicalArtifacts contract mismatch');
  }
  expected.physicalArtifacts.forEach((artifact, index) => {
    for (const field of ['index', 'file', 'bytes', 'sha256', 'sourceOffsetBytes', 'sourceEndOffsetBytesExclusive']) {
      requireEqual(manifest.physicalArtifacts[index]?.[field], artifact[field], `manifest.physicalArtifacts[${index}].${field}`);
    }
  });
  const tile = manifest?.tile;
  for (const field of ['tileIndex', 'startRow', 'endRowExclusive', 'rowCount', 'byteLength']) {
    requireEqual(tile?.[field], expected.tile[field], `manifest.tile.${field}`);
  }
  if (!Array.isArray(tile?.physicalSlices) || tile.physicalSlices.length !== 2) {
    throw new Error('manifest.tile.physicalSlices contract mismatch');
  }
  expected.tile.physicalSlices.forEach((slice, index) => {
    for (const field of ['physicalArtifactIndex', 'startRow', 'endRowExclusive', 'rowCount', 'artifactByteOffset', 'byteLength']) {
      requireEqual(tile.physicalSlices[index]?.[field], slice[field], `manifest.tile.physicalSlices[${index}].${field}`);
    }
  });
  for (const mode of ['embedding', 'logits']) {
    for (const field of ['file', 'bytes', 'sha256']) {
      requireEqual(tile?.graphs?.[mode]?.[field], expected.tile.graphs[mode][field], `manifest.tile.graphs.${mode}.${field}`);
    }
  }
  return manifest;
}
