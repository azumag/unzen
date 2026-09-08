import { validateEndpointFiveWayWebGpuManifest } from './contract.js';

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

function physicalByIndex(payloads, index) {
  const payload = payloads.get(index);
  if (!payload) throw new Error(`missing verified physical payload ${index}`);
  return payload;
}

function sliceFloatView(payloads, slice, hiddenSize) {
  const payload = physicalByIndex(payloads, slice.physicalArtifactIndex);
  return new Float32Array(
    payload.data.buffer,
    payload.data.byteOffset + slice.artifactByteOffset,
    slice.byteLength / FLOAT32_BYTES,
  );
}

function resolveLocalRow(tile, localRow) {
  let cursor = 0;
  for (const slice of tile.physicalSlices) {
    const next = cursor + slice.rowCount;
    if (localRow >= cursor && localRow < next) {
      return { slice, sliceLocalRow: localRow - cursor };
    }
    cursor = next;
  }
  throw new Error(`local row ${localRow} outside selected execution tile`);
}

function referenceEmbedding(payloads, tile, localIds, hiddenSize) {
  const result = new Float32Array(localIds.length * hiddenSize);
  localIds.forEach((id, outRow) => {
    const { slice, sliceLocalRow } = resolveLocalRow(tile, id);
    const source = sliceFloatView(payloads, slice, hiddenSize);
    result.set(
      source.subarray(sliceLocalRow * hiddenSize, (sliceLocalRow + 1) * hiddenSize),
      outRow * hiddenSize,
    );
  });
  return result;
}

function referenceLogits(payloads, tile, hiddenSize) {
  const result = new Float32Array(tile.rowCount);
  let outputRow = 0;
  for (const slice of tile.physicalSlices) {
    const source = sliceFloatView(payloads, slice, hiddenSize);
    for (let row = 0; row < slice.rowCount; row += 1) {
      let value = 0;
      for (let index = 0; index < sparseColumns.length; index += 1) {
        value += source[row * hiddenSize + sparseColumns[index]] * sparseCoefficients[index];
      }
      result[outputRow] = value;
      outputRow += 1;
    }
  }
  if (outputRow !== tile.rowCount) throw new Error('reference logits row coverage mismatch');
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

async function runGraph(graphInfo, physicalArtifacts, payloads, feeds) {
  const graph = await loadVerified(`./data/${graphInfo.file}`, graphInfo.bytes, graphInfo.sha256);
  const externalData = physicalArtifacts.map((artifact) => ({
    path: artifact.file,
    data: physicalByIndex(payloads, artifact.index).data,
  }));
  const started = performance.now();
  const session = await ort.InferenceSession.create(graph.data, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
    externalData,
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

async function runTile(tile, manifest, payloads) {
  const localIds = new BigInt64Array([0n, BigInt(Math.floor(tile.rowCount / 2)), BigInt(tile.rowCount - 1)]);
  const embeddingReference = referenceEmbedding(payloads, tile, [...localIds].map(Number), manifest.hiddenSize);
  const embeddingRun = await runGraph(tile.graphs.embedding, manifest.physicalArtifacts, payloads, {
    local_ids: new ort.Tensor('int64', localIds, [localIds.length]),
  });
  const embedding = compare(embeddingRun.outputs.embedding.data, embeddingReference, { exact: true });
  if (!embedding.allClose) throw new Error(`tile ${tile.tileIndex} embedding mismatch`);

  const hidden = new Float32Array(manifest.hiddenSize);
  sparseColumns.forEach((column, index) => { hidden[column] = sparseCoefficients[index]; });
  const logitsReference = referenceLogits(payloads, tile, manifest.hiddenSize);
  const logitsRun = await runGraph(tile.graphs.logits, manifest.physicalArtifacts, payloads, {
    hidden: new ort.Tensor('float32', hidden, [1, manifest.hiddenSize]),
  });
  const logits = compare(logitsRun.outputs.tile_logits.data, logitsReference);
  if (!logits.allClose) throw new Error(`tile ${tile.tileIndex} logits mismatch`);

  return {
    tileIndex: tile.tileIndex,
    physicalSlices: tile.physicalSlices,
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
  validateEndpointFiveWayWebGpuManifest(manifest);

  const payloads = new Map();
  for (const artifact of manifest.physicalArtifacts) {
    setStatus(`loading physical payload ${artifact.index}`);
    const loaded = await loadVerified(`./data/${artifact.file}`, artifact.bytes, artifact.sha256);
    payloads.set(artifact.index, { ...loaded, file: artifact.file });
  }

  setStatus(`executing cross-artifact tile ${manifest.tile.tileIndex}`);
  const executedTile = await runTile(manifest.tile, manifest, payloads);
  const report = {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-five-way-tile-ort-webgpu-runtime',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'self-reported-runtime',
    userAgent: navigator.userAgent,
    adapterInfo,
    adapterLimits,
    onnxruntimeWebVersion: manifest.onnxruntimeWebVersion,
    sourceGraphSha256: manifest.sourceGraphSha256,
    physicalArtifacts: manifest.physicalArtifacts.map((artifact) => ({
      index: artifact.index,
      bytes: artifact.bytes,
      sha256: physicalByIndex(payloads, artifact.index).sha256,
    })),
    fullPhysicalDependencyBytes: manifest.physicalArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    executedTile,
    sessionReleaseApiCompleted: executedTile.embedding.sessionReleaseMs >= 0 && executedTile.logits.sessionReleaseMs >= 0,
    conclusion: 'Real browser ORT Web/WebGPU executed one diagnostic 5-way boundary-crossing tied-weight tile from two independently verified physical payloads using two external initializers plus Concat. This proves browser multi-artifact primitive feasibility only. It does not select the 5-way architecture, approve Concat as a production strategy, measure peak host/GPU working set or immediate GPU-memory reclamation, define cache/runtime/dispatcher semantics, or prove final-norm/full-vs-staged equivalence.',
  };
  window.__unzenEndpointFiveWayWebGpuReport = report;
  reportEl.textContent = JSON.stringify(report, null, 2);
  setStatus('pass');
}

try {
  await main();
} catch (error) {
  const report = {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-five-way-tile-ort-webgpu-runtime',
    status: 'fail',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'self-reported-runtime',
    error: error instanceof Error ? error.message : String(error),
  };
  window.__unzenEndpointFiveWayWebGpuReport = report;
  reportEl.textContent = JSON.stringify(report, null, 2);
  setStatus('fail');
}
