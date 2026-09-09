export const ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED = Object.freeze({
  manifestKind: 'unzen-pinned-llama-1b-endpoint-embedding-eight-physical-payload-preparation',
  schemaVersion: '1.0.0',
  sourceGraphSha256: 'a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46',
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
  candidatePhysicalArtifactCount: 8,
  executionTileCount: 8,
  rowsPerTile: 16032,
  tileBytes: 131334144,
  totalEmbeddingBytes: 1050673152,
  graphFile: 'embedding-offset-0.onnx',
  graphBytes: 260,
  graphSha256: '70a56611e458eb6af8333329424756275aa5ad6b08467fa51912532867b6ce50',
  graphExternalDataPath: 'payload-0000.bin',
});

export const ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED = Object.freeze({
  preflightKind: 'unzen-pinned-llama-1b-endpoint-embedding-eight-physical-bundle-preflight',
  browserPlanKind: 'unzen-pinned-llama-1b-endpoint-embedding-eight-physical-ort-webgpu-plan',
  runtimeReportKind: 'unzen-pinned-llama-1b-endpoint-embedding-eight-physical-ort-webgpu-runtime',
  schemaVersion: '1.0.0',
  onnxruntimeWebVersion: '1.22.0',
  evidenceBoundary: 'actual-file-integrity-preflight-only',
});

const CANONICAL_SHA256 = /^[0-9a-f]{64}$/;

function requireEqual(actual, expected, field) {
  if (actual !== expected) throw new Error(`${field} contract mismatch`);
}

function requireCanonicalSha256(value, field) {
  if (typeof value !== 'string' || !CANONICAL_SHA256.test(value)) {
    throw new Error(`${field} must be a canonical lowercase SHA-256`);
  }
}

function requireObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireArray(value, field, length) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${field} must contain exactly ${length} entries`);
  }
  return value;
}

function requireExactObject(actual, expected, field) {
  const object = requireObject(actual, field);
  for (const [key, value] of Object.entries(expected)) {
    requireEqual(object[key], value, `${field}.${key}`);
  }
  return object;
}

export function validateEndpointEmbeddingEightPhysicalManifest(manifest) {
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
  requireObject(manifest, 'manifest');
  requireEqual(manifest.kind, expected.manifestKind, 'manifest.kind');
  requireEqual(manifest.schemaVersion, expected.schemaVersion, 'manifest.schemaVersion');
  requireEqual(manifest.status, 'pass', 'manifest.status');
  requireEqual(manifest.decisionStatus, 'diagnostic-only', 'manifest.decisionStatus');
  requireEqual(manifest.selectedPhysicalArtifactCount, null, 'manifest.selectedPhysicalArtifactCount');
  requireEqual(
    manifest.candidatePhysicalArtifactCount,
    expected.candidatePhysicalArtifactCount,
    'manifest.candidatePhysicalArtifactCount',
  );
  requireEqual(manifest.executionTileCount, expected.executionTileCount, 'manifest.executionTileCount');
  requireEqual(manifest.sourceGraphSha256, expected.sourceGraphSha256, 'manifest.sourceGraphSha256');
  requireExactObject(manifest.sourceExternalData, expected.sourceExternalData, 'manifest.sourceExternalData');
  requireExactObject(manifest.embeddingInitializer, expected.embeddingInitializer, 'manifest.embeddingInitializer');
  requireCanonicalSha256(manifest.payloadSetSha256, 'manifest.payloadSetSha256');

  const artifacts = requireArray(
    manifest.physicalArtifacts,
    'manifest.physicalArtifacts',
    expected.candidatePhysicalArtifactCount,
  );
  const tiles = requireArray(manifest.tiles, 'manifest.tiles', expected.executionTileCount);

  for (let index = 0; index < expected.candidatePhysicalArtifactCount; index += 1) {
    const artifact = requireObject(artifacts[index], `manifest.physicalArtifacts[${index}]`);
    const expectedSourceOffset = index * expected.tileBytes;
    requireEqual(artifact.index, index, `manifest.physicalArtifacts[${index}].index`);
    requireEqual(
      artifact.file,
      `payload-${String(index).padStart(4, '0')}.bin`,
      `manifest.physicalArtifacts[${index}].file`,
    );
    requireEqual(artifact.bytes, expected.tileBytes, `manifest.physicalArtifacts[${index}].bytes`);
    requireCanonicalSha256(artifact.sha256, `manifest.physicalArtifacts[${index}].sha256`);
    requireEqual(
      artifact.sourceOffsetBytes,
      expectedSourceOffset,
      `manifest.physicalArtifacts[${index}].sourceOffsetBytes`,
    );
    requireEqual(
      artifact.sourceEndOffsetBytesExclusive,
      expectedSourceOffset + expected.tileBytes,
      `manifest.physicalArtifacts[${index}].sourceEndOffsetBytesExclusive`,
    );

    const tile = requireObject(tiles[index], `manifest.tiles[${index}]`);
    const expectedStartRow = index * expected.rowsPerTile;
    requireEqual(tile.tileIndex, index, `manifest.tiles[${index}].tileIndex`);
    requireEqual(tile.startRow, expectedStartRow, `manifest.tiles[${index}].startRow`);
    requireEqual(
      tile.endRowExclusive,
      expectedStartRow + expected.rowsPerTile,
      `manifest.tiles[${index}].endRowExclusive`,
    );
    requireEqual(tile.rowCount, expected.rowsPerTile, `manifest.tiles[${index}].rowCount`);
    requireEqual(
      tile.physicalArtifactIndex,
      index,
      `manifest.tiles[${index}].physicalArtifactIndex`,
    );
    requireEqual(tile.artifactByteOffset, 0, `manifest.tiles[${index}].artifactByteOffset`);
    requireEqual(tile.byteLength, expected.tileBytes, `manifest.tiles[${index}].byteLength`);
  }

  const coverage = requireObject(manifest.coverage, 'manifest.coverage');
  requireEqual(coverage.sourceOffsetBytes, 0, 'manifest.coverage.sourceOffsetBytes');
  requireEqual(
    coverage.sourceEndOffsetBytesExclusive,
    expected.totalEmbeddingBytes,
    'manifest.coverage.sourceEndOffsetBytesExclusive',
  );
  requireEqual(coverage.bytes, expected.totalEmbeddingBytes, 'manifest.coverage.bytes');
  requireEqual(coverage.contiguous, true, 'manifest.coverage.contiguous');
  requireEqual(
    coverage.tileToPhysicalArtifactOneToOne,
    true,
    'manifest.coverage.tileToPhysicalArtifactOneToOne',
  );

  if (!Array.isArray(manifest.remainingRuntimeEvidence)
      || !manifest.remainingRuntimeEvidence.includes('ort-webgpu-range-supply')) {
    throw new Error('manifest.remainingRuntimeEvidence must retain ort-webgpu-range-supply');
  }

  return manifest;
}

export function buildEndpointEmbeddingEightPhysicalRuntimePlan(manifest) {
  validateEndpointEmbeddingEightPhysicalManifest(manifest);
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
  return manifest.tiles.map((tile, tileIndex) => {
    const artifact = manifest.physicalArtifacts[tileIndex];
    return Object.freeze({
      tileIndex,
      startRow: tile.startRow,
      endRowExclusive: tile.endRowExclusive,
      physicalArtifactIndex: tileIndex,
      payloadFile: artifact.file,
      expectedPayloadBytes: artifact.bytes,
      expectedPayloadSha256: artifact.sha256,
      sourceOffsetBytes: artifact.sourceOffsetBytes,
      sourceEndOffsetBytesExclusive: artifact.sourceEndOffsetBytesExclusive,
      graphFile: expected.graphFile,
      expectedGraphBytes: expected.graphBytes,
      expectedGraphSha256: expected.graphSha256,
      graphExternalDataPath: expected.graphExternalDataPath,
      artifactByteOffset: 0,
      byteLength: expected.tileBytes,
    });
  });
}

export function validateEndpointEmbeddingEightPhysicalPreflightReport(report) {
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
  const browserExpected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED;
  requireObject(report, 'preflight');
  requireEqual(report.kind, browserExpected.preflightKind, 'preflight.kind');
  requireEqual(report.schemaVersion, browserExpected.schemaVersion, 'preflight.schemaVersion');
  requireEqual(report.status, 'pass', 'preflight.status');
  requireEqual(report.decisionStatus, 'diagnostic-only', 'preflight.decisionStatus');
  requireEqual(report.selectedPhysicalArtifactCount, null, 'preflight.selectedPhysicalArtifactCount');
  requireEqual(
    report.candidatePhysicalArtifactCount,
    expected.candidatePhysicalArtifactCount,
    'preflight.candidatePhysicalArtifactCount',
  );
  requireEqual(report.sourceGraphSha256, expected.sourceGraphSha256, 'preflight.sourceGraphSha256');
  requireExactObject(report.sourceExternalData, expected.sourceExternalData, 'preflight.sourceExternalData');
  requireCanonicalSha256(report.manifestPayloadSetSha256, 'preflight.manifestPayloadSetSha256');
  requireEqual(report.evidenceBoundary, browserExpected.evidenceBoundary, 'preflight.evidenceBoundary');

  const graph = requireObject(report.graph, 'preflight.graph');
  requireEqual(graph.file, expected.graphFile, 'preflight.graph.file');
  requireEqual(graph.bytes, expected.graphBytes, 'preflight.graph.bytes');
  requireEqual(graph.sha256, expected.graphSha256, 'preflight.graph.sha256');

  const payloads = requireArray(
    report.payloads,
    'preflight.payloads',
    expected.candidatePhysicalArtifactCount,
  );
  const runtimePlan = requireArray(
    report.runtimePlan,
    'preflight.runtimePlan',
    expected.executionTileCount,
  );

  for (let index = 0; index < expected.executionTileCount; index += 1) {
    const payload = requireObject(payloads[index], `preflight.payloads[${index}]`);
    const plan = requireObject(runtimePlan[index], `preflight.runtimePlan[${index}]`);
    const expectedFile = `payload-${String(index).padStart(4, '0')}.bin`;
    const expectedSourceOffset = index * expected.tileBytes;
    const expectedStartRow = index * expected.rowsPerTile;

    requireEqual(payload.index, index, `preflight.payloads[${index}].index`);
    requireEqual(payload.file, expectedFile, `preflight.payloads[${index}].file`);
    requireEqual(payload.bytes, expected.tileBytes, `preflight.payloads[${index}].bytes`);
    requireCanonicalSha256(payload.sha256, `preflight.payloads[${index}].sha256`);
    requireEqual(payload.sourceOffsetBytes, expectedSourceOffset, `preflight.payloads[${index}].sourceOffsetBytes`);
    requireEqual(
      payload.sourceEndOffsetBytesExclusive,
      expectedSourceOffset + expected.tileBytes,
      `preflight.payloads[${index}].sourceEndOffsetBytesExclusive`,
    );

    requireEqual(plan.tileIndex, index, `preflight.runtimePlan[${index}].tileIndex`);
    requireEqual(plan.startRow, expectedStartRow, `preflight.runtimePlan[${index}].startRow`);
    requireEqual(
      plan.endRowExclusive,
      expectedStartRow + expected.rowsPerTile,
      `preflight.runtimePlan[${index}].endRowExclusive`,
    );
    requireEqual(plan.physicalArtifactIndex, index, `preflight.runtimePlan[${index}].physicalArtifactIndex`);
    requireEqual(plan.payloadFile, payload.file, `preflight.runtimePlan[${index}].payloadFile`);
    requireEqual(plan.expectedPayloadBytes, payload.bytes, `preflight.runtimePlan[${index}].expectedPayloadBytes`);
    requireEqual(plan.expectedPayloadSha256, payload.sha256, `preflight.runtimePlan[${index}].expectedPayloadSha256`);
    requireEqual(plan.sourceOffsetBytes, payload.sourceOffsetBytes, `preflight.runtimePlan[${index}].sourceOffsetBytes`);
    requireEqual(
      plan.sourceEndOffsetBytesExclusive,
      payload.sourceEndOffsetBytesExclusive,
      `preflight.runtimePlan[${index}].sourceEndOffsetBytesExclusive`,
    );
    requireEqual(plan.graphFile, expected.graphFile, `preflight.runtimePlan[${index}].graphFile`);
    requireEqual(plan.expectedGraphBytes, expected.graphBytes, `preflight.runtimePlan[${index}].expectedGraphBytes`);
    requireEqual(plan.expectedGraphSha256, expected.graphSha256, `preflight.runtimePlan[${index}].expectedGraphSha256`);
    requireEqual(
      plan.graphExternalDataPath,
      expected.graphExternalDataPath,
      `preflight.runtimePlan[${index}].graphExternalDataPath`,
    );
    requireEqual(plan.artifactByteOffset, 0, `preflight.runtimePlan[${index}].artifactByteOffset`);
    requireEqual(plan.byteLength, expected.tileBytes, `preflight.runtimePlan[${index}].byteLength`);
  }

  return report;
}

export function buildEndpointEmbeddingEightPhysicalBrowserPlan(preflightReport) {
  validateEndpointEmbeddingEightPhysicalPreflightReport(preflightReport);
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
  const browserExpected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED;
  const tokenIds = [];
  const tiles = preflightReport.runtimePlan.map((entry, index) => {
    const rowCount = entry.endRowExclusive - entry.startRow;
    const positions = [index * 2, index * 2 + 1];
    const globalTokenIds = [entry.startRow, entry.endRowExclusive - 1];
    const localTokenIds = [0, rowCount - 1];
    tokenIds.push(...globalTokenIds);
    return Object.freeze({
      ...entry,
      rowCount,
      positions: Object.freeze(positions),
      globalTokenIds: Object.freeze(globalTokenIds),
      localTokenIds: Object.freeze(localTokenIds),
    });
  });

  return Object.freeze({
    kind: browserExpected.browserPlanKind,
    runtimeReportKind: browserExpected.runtimeReportKind,
    schemaVersion: browserExpected.schemaVersion,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    candidatePhysicalArtifactCount: expected.candidatePhysicalArtifactCount,
    executionTileCount: expected.executionTileCount,
    hiddenSize: expected.embeddingInitializer.hiddenSize,
    onnxruntimeWebVersion: browserExpected.onnxruntimeWebVersion,
    sourceGraphSha256: expected.sourceGraphSha256,
    sourceExternalData: Object.freeze({ ...expected.sourceExternalData }),
    embeddingInitializer: Object.freeze({ ...expected.embeddingInitializer }),
    manifestPayloadSetSha256: preflightReport.manifestPayloadSetSha256,
    graph: Object.freeze({ ...preflightReport.graph }),
    graphExternalDataPath: expected.graphExternalDataPath,
    physicalArtifacts: Object.freeze(preflightReport.payloads.map((payload) => Object.freeze({ ...payload }))),
    tokenIds: Object.freeze(tokenIds),
    tiles: Object.freeze(tiles),
    sequentialExecution: Object.freeze({
      physicalArtifactOrder: Object.freeze(Array.from({ length: expected.candidatePhysicalArtifactCount }, (_, index) => index)),
      tilesPerPhysicalArtifact: 1,
      maximumWholePhysicalPayloadBytesPerStep: expected.tileBytes,
      totalPhysicalPayloadBytesVerifiedAcrossRun: expected.totalEmbeddingBytes,
    }),
  });
}
