import { validateEndpointTileWebGpuManifest } from './contract.js';
const statusEl = document.querySelector('#status');
const reportEl = document.querySelector('#report');
const FLOAT32_BYTES = 4;
const ATOL = 1e-6;
const RTOL = 1e-6;
const sparseColumns = [0, 17, 2047];
const sparseCoefficients = [0.5, -0.25, 0.125];

function setStatus(value) {
  statusEl.textContent = value;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function loadVerified(path, expectedBytes, expectedSha256) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`fetch ${path} failed: ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength !== expectedBytes) throw new Error(`${path} byte length mismatch`);
  const sha256 = await sha256Hex(data);
  if (sha256 !== expectedSha256) throw new Error(`${path} SHA-256 mismatch`);
  return { data, sha256 };
}

function referenceEmbedding(payload, tile, localIds, hiddenSize) {
  const result = new Float32Array(localIds.length * hiddenSize);
  const source = new Float32Array(payload.buffer, payload.byteOffset + tile.artifactByteOffset, tile.byteLength / FLOAT32_BYTES);
  localIds.forEach((id, outRow) => {
    result.set(source.subarray(id * hiddenSize, (id + 1) * hiddenSize), outRow * hiddenSize);
  });
  return result;
}

function referenceLogits(payload, tile, hiddenSize) {
  const source = new Float32Array(payload.buffer, payload.byteOffset + tile.artifactByteOffset, tile.byteLength / FLOAT32_BYTES);
  const result = new Float32Array(tile.rowCount);
  for (let row = 0; row < tile.rowCount; row += 1) {
    let value = 0;
    for (let index = 0; index < sparseColumns.length; index += 1) {
      value += source[row * hiddenSize + sparseColumns[index]] * sparseCoefficients[index];
    }
    result[row] = value;
  }
  return result;
}

function compare(actual, expected, { exact = false } = {}) {
  if (actual.length !== expected.length) throw new Error('comparison length mismatch');
  let maxAbsDiff = 0;
  let maxRelativeDiff = 0;
  let allClose = true;
  for (let index = 0; index < actual.length; index += 1) {
    const diff = Math.abs(actual[index] - expected[index]);
    maxAbsDiff = Math.max(maxAbsDiff, diff);
    const denom = Math.max(Math.abs(expected[index]), 1e-12);
    maxRelativeDiff = Math.max(maxRelativeDiff, diff / denom);
    if (exact ? actual[index] !== expected[index] : diff > ATOL + RTOL * Math.abs(expected[index])) allClose = false;
  }
  return { allClose, exactEqual: exact ? allClose : undefined, maxAbsDiff, maxRelativeDiff };
}

async function runGraph(graphInfo, payloadInfo, feeds) {
  const graph = await loadVerified(`./data/${graphInfo.file}`, graphInfo.bytes, graphInfo.sha256);
  const started = performance.now();
  const session = await ort.InferenceSession.create(graph.data, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
    externalData: [{ path: payloadInfo.file, data: payloadInfo.bytesData }],
  });
  const sessionCreateMs = performance.now() - started;
  let outputs;
  let runMs;
  let sessionReleaseMs;
  try {
    const runStarted = performance.now();
    outputs = await session.run(feeds);
    runMs = performance.now() - runStarted;
  } finally {
    const releaseStarted = performance.now();
    await session.release();
    sessionReleaseMs = performance.now() - releaseStarted;
  }
  return { outputs, sessionCreateMs, runMs, sessionReleaseMs };
}

async function runTile(tile, manifest, payloadInfo) {
  const localIds = new BigInt64Array([0n, BigInt(Math.floor(tile.rowCount / 2)), BigInt(tile.rowCount - 1)]);
  const embeddingReference = referenceEmbedding(payloadInfo.bytesData, tile, [...localIds].map(Number), manifest.hiddenSize);
  const embeddingRun = await runGraph(tile.graphs.embedding, payloadInfo, {
    local_ids: new ort.Tensor('int64', localIds, [localIds.length]),
  });
  const embeddingActual = embeddingRun.outputs.embedding.data;
  const embedding = compare(embeddingActual, embeddingReference, { exact: true });
  if (!embedding.allClose) throw new Error(`tile ${tile.tileIndex} embedding mismatch`);

  const hidden = new Float32Array(manifest.hiddenSize);
  sparseColumns.forEach((column, index) => { hidden[column] = sparseCoefficients[index]; });
  const logitsReference = referenceLogits(payloadInfo.bytesData, tile, manifest.hiddenSize);
  const logitsRun = await runGraph(tile.graphs.logits, payloadInfo, {
    hidden: new ort.Tensor('float32', hidden, [1, manifest.hiddenSize]),
  });
  const logitsActual = logitsRun.outputs.tile_logits.data;
  const logits = compare(logitsActual, logitsReference);
  if (!logits.allClose) throw new Error(`tile ${tile.tileIndex} logits mismatch`);

  return {
    tileIndex: tile.tileIndex,
    artifactByteOffset: tile.artifactByteOffset,
    byteLength: tile.byteLength,
    embedding: {
      ...embedding,
      localIds: [...localIds].map(Number),
      sessionCreateMs: embeddingRun.sessionCreateMs,
      runMs: embeddingRun.runMs,
      sessionReleaseMs: embeddingRun.sessionReleaseMs,
    },
    logits: {
      ...logits,
      sparseColumns,
      sparseCoefficients,
      atol: ATOL,
      rtol: RTOL,
      sessionCreateMs: logitsRun.sessionCreateMs,
      runMs: logitsRun.runMs,
      sessionReleaseMs: logitsRun.sessionReleaseMs,
    },
  };
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

  setStatus('loading manifest');
  const manifestResponse = await fetch('./data/manifest.json', { cache: 'no-store' });
  if (!manifestResponse.ok) throw new Error(`manifest fetch failed: ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  validateEndpointTileWebGpuManifest(manifest);
  const physical = manifest.physicalArtifact;
  setStatus('loading 250.5 MiB physical payload');
  const payload = await loadVerified(`./data/${physical.file}`, physical.bytes, physical.sha256);
  const payloadInfo = { file: physical.file, bytesData: payload.data };

  const executedTiles = [];
  for (const tile of manifest.tiles) {
    setStatus(`executing tile ${tile.tileIndex}`);
    executedTiles.push(await runTile(tile, manifest, payloadInfo));
  }

  const report = {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-preferred-tile-ort-webgpu-runtime',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'self-reported-runtime',
    userAgent: navigator.userAgent,
    adapterInfo,
    adapterLimits,
    onnxruntimeWebVersion: manifest.onnxruntimeWebVersion,
    sourceGraphSha256: manifest.sourceGraphSha256,
    physicalArtifact: { index: physical.index, bytes: physical.bytes, sha256: payload.sha256 },
    executedTiles,
    sessionReleaseApiCompleted: executedTiles.every((tile) => tile.embedding.sessionReleaseMs >= 0 && tile.logits.sessionReleaseMs >= 0),
    conclusion: 'Real browser ORT Web/WebGPU executed zero-offset and non-zero-offset ranges inside one verified preferred physical payload. InferenceSession.release() completed after each run, but that does not prove immediate GPU-memory reclamation. This remains diagnostic-only and does not select a 4-way/8-way architecture, establish full endpoint composition, measure peak host/GPU memory, or prove full-vs-staged equivalence.',
  };
  window.__unzenEndpointWebGpuReport = report;
  reportEl.textContent = JSON.stringify(report, null, 2);
  setStatus('pass');
}

try {
  await main();
} catch (error) {
  const report = {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-preferred-tile-ort-webgpu-runtime',
    status: 'fail',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'self-reported-runtime',
    error: error instanceof Error ? error.message : String(error),
  };
  window.__unzenEndpointWebGpuReport = report;
  reportEl.textContent = JSON.stringify(report, null, 2);
  setStatus('fail');
}
