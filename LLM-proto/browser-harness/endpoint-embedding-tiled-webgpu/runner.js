import { validateEndpointEmbeddingWebGpuManifest } from './contract.js';

const statusEl = document.querySelector('#status');
const reportEl = document.querySelector('#report');
const FLOAT32_BYTES = 4;

function setStatus(value) {
  statusEl.textContent = value;
  window.__unzenEndpointEmbeddingWebGpuPhase = value;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function loadVerified(path, expectedBytes, expectedSha256) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`fetch ${path} failed: ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength !== expectedBytes) {
    throw new Error(`${path} byte length mismatch: expected ${expectedBytes}, got ${data.byteLength}`);
  }
  const sha256 = await sha256Hex(data);
  if (sha256 !== expectedSha256) throw new Error(`${path} SHA-256 mismatch`);
  return { data, sha256 };
}

function referenceEmbedding(payload, tile, localIds, hiddenSize) {
  if (tile.byteLength !== tile.rowCount * hiddenSize * FLOAT32_BYTES) {
    throw new Error(`tile ${tile.tileIndex} byte geometry mismatch`);
  }
  const source = new Float32Array(
    payload.buffer,
    payload.byteOffset + tile.artifactByteOffset,
    tile.byteLength / FLOAT32_BYTES,
  );
  const result = new Float32Array(localIds.length * hiddenSize);
  localIds.forEach((id, outputRow) => {
    if (!Number.isInteger(id) || id < 0 || id >= tile.rowCount) {
      throw new Error(`tile ${tile.tileIndex} local token id out of range`);
    }
    result.set(
      source.subarray(id * hiddenSize, (id + 1) * hiddenSize),
      outputRow * hiddenSize,
    );
  });
  return result;
}

function compareExact(actual, expected) {
  if (actual.length !== expected.length) throw new Error('comparison length mismatch');
  let maxAbsDiff = 0;
  let worstIndex = -1;
  let exactEqual = true;
  for (let index = 0; index < actual.length; index += 1) {
    const diff = Math.abs(actual[index] - expected[index]);
    if (diff !== 0) exactEqual = false;
    if (diff > maxAbsDiff) {
      maxAbsDiff = diff;
      worstIndex = index;
    }
  }
  return { exactEqual, maxAbsDiff, worstIndex };
}

async function createSession(graphInfo, externalPath, externalBytes) {
  const graph = await loadVerified(
    `./data/${graphInfo.file}`,
    graphInfo.bytes,
    graphInfo.sha256,
  );
  const started = performance.now();
  const session = await ort.InferenceSession.create(graph.data, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
    externalData: [{ path: externalPath, data: externalBytes }],
  });
  return {
    session,
    graphSha256: graph.sha256,
    sessionCreateMs: performance.now() - started,
  };
}

async function runTile(tile, manifest, payloadBytes) {
  const graphInfo = manifest.graphVariants[tile.graphVariant];
  if (!graphInfo) throw new Error(`tile ${tile.tileIndex} graph variant missing`);
  if (graphInfo.artifactByteOffset !== tile.artifactByteOffset) {
    throw new Error(`tile ${tile.tileIndex} graph offset mismatch`);
  }
  const localIds = new BigInt64Array(tile.localTokenIds.map((value) => BigInt(value)));
  const reference = referenceEmbedding(
    payloadBytes,
    tile,
    tile.localTokenIds,
    manifest.hiddenSize,
  );
  const { session, graphSha256, sessionCreateMs } = await createSession(
    graphInfo,
    manifest.graphExternalDataPath,
    payloadBytes,
  );
  let actual;
  let runMs;
  let sessionReleaseMs;
  try {
    const started = performance.now();
    const outputs = await session.run({
      local_ids: new ort.Tensor('int64', localIds, [localIds.length]),
    });
    runMs = performance.now() - started;
    if (!outputs.embedding) throw new Error(`tile ${tile.tileIndex} embedding output is missing`);
    actual = new Float32Array(outputs.embedding.data);
  } finally {
    const releaseStarted = performance.now();
    await session.release();
    sessionReleaseMs = performance.now() - releaseStarted;
  }
  const comparison = compareExact(actual, reference);
  if (!comparison.exactEqual) {
    throw new Error(
      `tile ${tile.tileIndex} embedding mismatch: maxAbsDiff=${comparison.maxAbsDiff}`,
    );
  }
  return {
    actual,
    reference,
    report: {
      tileIndex: tile.tileIndex,
      startRow: tile.startRow,
      endRowExclusive: tile.endRowExclusive,
      physicalArtifactIndex: tile.physicalArtifactIndex,
      artifactByteOffset: tile.artifactByteOffset,
      byteLength: tile.byteLength,
      positions: tile.positions,
      globalTokenIds: tile.globalTokenIds,
      localTokenIds: tile.localTokenIds,
      graphVariant: tile.graphVariant,
      graphSha256,
      comparison,
      sessionCreateMs,
      runMs,
      sessionReleaseMs,
    },
  };
}

function placeRows(target, values, positions, hiddenSize) {
  if (values.length !== positions.length * hiddenSize) {
    throw new Error('row placement geometry mismatch');
  }
  positions.forEach((position, rowIndex) => {
    target.set(
      values.subarray(rowIndex * hiddenSize, (rowIndex + 1) * hiddenSize),
      position * hiddenSize,
    );
  });
}

async function main() {
  if (!navigator.gpu) throw new Error('WebGPU unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const adapterInfo = adapter.info ? {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  } : null;
  const adapterLimits = {
    maxBufferSize: Number(adapter.limits.maxBufferSize),
    maxStorageBufferBindingSize: Number(adapter.limits.maxStorageBufferBindingSize),
    maxComputeWorkgroupStorageSize: Number(adapter.limits.maxComputeWorkgroupStorageSize),
  };

  setStatus('loading and validating pinned manifest');
  const manifestResponse = await fetch('./data/manifest.json', { cache: 'no-store' });
  if (!manifestResponse.ok) throw new Error(`manifest fetch failed: ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  validateEndpointEmbeddingWebGpuManifest(manifest);

  const completeValues = manifest.tokenIds.length * manifest.hiddenSize;
  const completeActual = new Float32Array(completeValues);
  const completeReference = new Float32Array(completeValues);
  const executedTiles = [];
  const verifiedPhysicalArtifacts = [];

  for (const artifactIndex of manifest.sequentialExecution.physicalArtifactOrder) {
    const payload = manifest.physicalArtifacts.find((item) => item.index === artifactIndex);
    if (!payload) throw new Error(`physical artifact ${artifactIndex} missing`);
    setStatus(`loading and verifying physical payload ${artifactIndex}`);
    const verified = await loadVerified(`./data/${payload.file}`, payload.bytes, payload.sha256);
    verifiedPhysicalArtifacts.push({
      index: artifactIndex,
      bytes: payload.bytes,
      sha256: verified.sha256,
    });

    const tiles = manifest.tiles.filter((tile) => tile.physicalArtifactIndex === artifactIndex);
    if (tiles.length !== manifest.sequentialExecution.tilesPerPhysicalArtifact) {
      throw new Error(`physical artifact ${artifactIndex} tile count mismatch`);
    }
    for (const tile of tiles) {
      setStatus(`executing embedding tile ${tile.tileIndex}`);
      const result = await runTile(tile, manifest, verified.data);
      placeRows(completeActual, result.actual, tile.positions, manifest.hiddenSize);
      placeRows(completeReference, result.reference, tile.positions, manifest.hiddenSize);
      executedTiles.push(result.report);
    }
  }

  const completeEmbeddingComparison = compareExact(completeActual, completeReference);
  if (!completeEmbeddingComparison.exactEqual) {
    throw new Error(
      `complete embedding mismatch: maxAbsDiff=${completeEmbeddingComparison.maxAbsDiff}`,
    );
  }
  const report = {
    schemaVersion: '1.0.0',
    kind: manifest.runtimeReportKind,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'self-reported-runtime',
    userAgent: navigator.userAgent,
    adapterInfo,
    adapterLimits,
    onnxruntimeWebVersion: manifest.onnxruntimeWebVersion,
    sourceGraphSha256: manifest.sourceGraphSha256,
    sourceExternalData: manifest.sourceExternalData,
    embeddingInitializer: manifest.embeddingInitializer,
    tokenIds: manifest.tokenIds,
    verifiedPhysicalArtifacts,
    executedTiles,
    completeEmbeddingComparison,
    outputShape: [manifest.tokenIds.length, manifest.hiddenSize],
    sequentialExecution: manifest.sequentialExecution,
    sessionReleaseApiCompleted: executedTiles.every((item) => item.sessionReleaseMs >= 0),
    conclusion: 'A real browser ORT Web/WebGPU run routed both ends of every vocabulary tile through all four verified preferred physical payloads, assembled the complete [16,2048] embedding result, and compared every value byte-exactly with the corresponding verified payload bytes. This remains diagnostic-only and does not select the 4-way/8-way architecture, define production cache/runtime/dispatcher semantics, or prove decoder/KV/checkpoint full-model staged equivalence.',
  };
  window.__unzenEndpointEmbeddingWebGpuReport = report;
  reportEl.textContent = JSON.stringify(report, null, 2);
  setStatus('pass');
}

try {
  await main();
} catch (error) {
  const report = {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-embedding-tiled-ort-webgpu-runtime',
    status: 'fail',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'self-reported-runtime',
    error: error instanceof Error ? error.message : String(error),
  };
  window.__unzenEndpointEmbeddingWebGpuReport = report;
  reportEl.textContent = JSON.stringify(report, null, 2);
  setStatus('fail');
}
