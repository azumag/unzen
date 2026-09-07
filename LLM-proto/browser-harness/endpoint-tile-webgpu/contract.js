export const ENDPOINT_TILE_WEBGPU_EXPECTED = Object.freeze({
  manifestKind: 'unzen-pinned-llama-1b-endpoint-preferred-tile-ort-webgpu-preparation',
  schemaVersion: '1.0.0',
  sourceGraphSha256: 'a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46',
  sourceExternalBytes: 1692672000,
  sourceExternalSha256: '07cc629ef2cb7fdb18615ce2e4f3774f763e6fc840207d772a8b511eead36647',
  payloadFile: 'payload-0000.bin',
  payloadBytes: 262668288,
  payloadSha256: 'b783704059e886b1e5438d23c3f9911b0d947c86125501c9071e5bb8f7cebdce',
  hiddenSize: 2048,
  physicalArtifactCount: 4,
  executionTileCount: 8,
  selectedTileIndices: [0, 1],
  onnxruntimeWebVersion: '1.22.0',
  tiles: [
    { tileIndex: 0, startRow: 0, endRowExclusive: 16032, rowCount: 16032, artifactByteOffset: 0, byteLength: 131334144,
      graphs: { embedding: { file: 'tile-0-embedding.onnx', bytes: 260, sha256: '70a56611e458eb6af8333329424756275aa5ad6b08467fa51912532867b6ce50' }, logits: { file: 'tile-0-logits.onnx', bytes: 327, sha256: 'b5c5ec195486f3c55208856534710badeb60dba2bf9e014ec80f46781c2159d8' } } },
    { tileIndex: 1, startRow: 16032, endRowExclusive: 32064, rowCount: 16032, artifactByteOffset: 131334144, byteLength: 131334144,
      graphs: { embedding: { file: 'tile-1-embedding.onnx', bytes: 268, sha256: 'bf43c241540197eb23e9d0768da23e4e81cbcdf80b145c93a91b5ee508b9d52a' }, logits: { file: 'tile-1-logits.onnx', bytes: 335, sha256: '8245a82b1a88f8aa306fa4f488df4ec6c648293542bbfac07a1be367d8c48d5b' } } },
  ],
});

function requireEqual(actual, expected, field) {
  if (actual !== expected) throw new Error(`${field} contract mismatch`);
}

export function validateEndpointTileWebGpuManifest(manifest) {
  const expected = ENDPOINT_TILE_WEBGPU_EXPECTED;
  requireEqual(manifest?.kind, expected.manifestKind, 'manifest.kind');
  requireEqual(manifest?.schemaVersion, expected.schemaVersion, 'manifest.schemaVersion');
  requireEqual(manifest?.status, 'pass', 'manifest.status');
  requireEqual(manifest?.decisionStatus, 'diagnostic-only', 'manifest.decisionStatus');
  requireEqual(manifest?.sourceGraphSha256, expected.sourceGraphSha256, 'manifest.sourceGraphSha256');
  requireEqual(manifest?.sourceExternalData?.bytes, expected.sourceExternalBytes, 'manifest.sourceExternalData.bytes');
  requireEqual(manifest?.sourceExternalData?.sha256, expected.sourceExternalSha256, 'manifest.sourceExternalData.sha256');
  requireEqual(manifest?.physicalArtifactCount, expected.physicalArtifactCount, 'manifest.physicalArtifactCount');
  requireEqual(manifest?.executionTileCount, expected.executionTileCount, 'manifest.executionTileCount');
  requireEqual(manifest?.hiddenSize, expected.hiddenSize, 'manifest.hiddenSize');
  requireEqual(manifest?.onnxruntimeWebVersion, expected.onnxruntimeWebVersion, 'manifest.onnxruntimeWebVersion');
  if (JSON.stringify(manifest?.selectedTileIndices) !== JSON.stringify(expected.selectedTileIndices)) {
    throw new Error('manifest.selectedTileIndices contract mismatch');
  }
  requireEqual(manifest?.physicalArtifact?.index, 0, 'manifest.physicalArtifact.index');
  requireEqual(manifest?.physicalArtifact?.file, expected.payloadFile, 'manifest.physicalArtifact.file');
  requireEqual(manifest?.physicalArtifact?.bytes, expected.payloadBytes, 'manifest.physicalArtifact.bytes');
  requireEqual(manifest?.physicalArtifact?.sha256, expected.payloadSha256, 'manifest.physicalArtifact.sha256');
  if (!Array.isArray(manifest?.tiles) || manifest.tiles.length !== expected.tiles.length) {
    throw new Error('manifest.tiles contract mismatch');
  }
  expected.tiles.forEach((expectedTile, index) => {
    const actual = manifest.tiles[index];
    for (const field of ['tileIndex', 'startRow', 'endRowExclusive', 'rowCount', 'artifactByteOffset', 'byteLength']) {
      requireEqual(actual?.[field], expectedTile[field], `manifest.tiles[${index}].${field}`);
    }
    for (const mode of ['embedding', 'logits']) {
      for (const field of ['file', 'bytes', 'sha256']) {
        requireEqual(actual?.graphs?.[mode]?.[field], expectedTile.graphs[mode][field], `manifest.tiles[${index}].graphs.${mode}.${field}`);
      }
    }
  });
  return manifest;
}
