import { buildEndpointEmbeddingEightPhysicalBrowserPlan } from './contract.js';

const statusEl = document.querySelector('#status');
const reportEl = document.querySelector('#report');
const FLOAT32_BYTES = 4;

function setStatus(value) {
  statusEl.textContent = value;
  window.__unzenEndpointEmbeddingEightPhysicalWebGpuPhase = value;
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

function referenceEmbedding(payload, tile, hiddenSize) {
  if (tile.artifactByteOffset !== 0) {
    throw new Error(`tile ${tile.tileIndex} must use zero artifact offset`);
  }
  if (tile.byteLength !== tile.rowCount * hiddenSize * FLOAT32_BYTES) {
    throw new Error(`tile ${tile.tileIndex} byte geometry mismatch`);
  }
  const source = new Float32Array(
    payload.buffer,
    payload.byteOffset,
    tile.byteLength / FLOAT32_BYTES,
  );
  const result = new Float32Array(tile.localTokenIds.length * hiddenSize);
  tile.localTokenIds.forEach((id, outputRow) => {
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
  const actualBytes = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
  const expectedBytes = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
  let firstByteMismatch = -1;
  for (let index = 0; index < actualBytes.length; index += 1) {
    if (actualBytes[index] !== expectedBytes[index]) {
      firstByteMismatch = index;
      break;
    }
  }

  let maxAbsDiff = 0;
  let worstIndex = -1;
  for (let index = 0; index < actual.length; index += 1) {
    const diff = Math.abs(actual[index] - expected[index]);
    if (Number.isNaN(diff)) {
      if (firstByteMismatch !== -1 && worstIndex === -1) worstIndex = index;
      continue;
    }
    if (diff > maxAbsDiff) {
      maxAbsDiff = diff;
      worstIndex = index;
    }
  }
  return {
    exactEqual: firstByteMismatch === -1,
    firstByteMismatch,
    maxAbsDiff,
    worstIndex,
  };
}

async function createSession(graphBytes, graphExternalDataPath, payloadBytes) {
  const started = performance.now();
  const session = await ort.InferenceSession.create(graphBytes, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
    externalData: [{ path: graphExternalDataPath, data: payloadBytes }],
  });
  return {
    session,
    sessionCreateMs: performance.now() - started,
  };
}

async function runTile(tile, plan, payloadBytes, graphBytes, graphSha256, payloadSha256) {
  const localIds = new BigInt64Array(tile.localTokenIds.map((value) => BigInt(value)));
  const reference = referenceEmbedding(payloadBytes, tile, plan.hiddenSize);
  const { session, sessionCreateMs } = await createSession(
    graphBytes,
    plan.graphExternalDataPath,
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
      `tile ${tile.tileIndex} embedding byte mismatch: firstByteMismatch=${comparison.firstByteMismatch}, maxAbsDiff=${comparison.maxAbsDiff}`,
    );
  }

  return {
    actual,
    reference,
    report: {
      tileIndex: tile.tileIndex,
      startRow: tile.startRow,
      endRowExclusive: tile.endRowExclusive,
      rowCount: tile.rowCount,
      physicalArtifactIndex: tile.physicalArtifactIndex,
      payloadFile: tile.payloadFile,
      payloadSha256,
      sourceOffsetBytes: tile.sourceOffsetBytes,
      sourceEndOffsetBytesExclusive: tile.sourceEndOffsetBytesExclusive,
      artifactByteOffset: tile.artifactByteOffset,
      byteLength: tile.byteLength,
      positions: tile.positions,
      globalTokenIds: tile.globalTokenIds,
      localTokenIds: tile.localTokenIds,
      graphFile: tile.graphFile,
      graphSha256,
      graphExternalDataPath: tile.graphExternalDataPath,
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

  setStatus('loading validated actual-file preflight report');
  const preflightResponse = await fetch('./data/preflight.json', { cache: 'no-store' });
  if (!preflightResponse.ok) {
    throw new Error(`preflight report fetch failed: ${preflightResponse.status}`);
  }
  const preflight = await preflightResponse.json();
  const plan = buildEndpointEmbeddingEightPhysicalBrowserPlan(preflight);

  setStatus('loading and verifying pinned zero-offset graph');
  const verifiedGraph = await loadVerified(
    `./data/${plan.graph.file}`,
    plan.graph.bytes,
    plan.graph.sha256,
  );

  const completeValues = plan.tokenIds.length * plan.hiddenSize;
  const completeActual = new Float32Array(completeValues);
  const completeReference = new Float32Array(completeValues);
  const executedTiles = [];
  const verifiedPhysicalArtifacts = [];

  for (const artifactIndex of plan.sequentialExecution.physicalArtifactOrder) {
    const payload = plan.physicalArtifacts[artifactIndex];
    const tile = plan.tiles[artifactIndex];
    if (!payload || !tile) throw new Error(`physical artifact ${artifactIndex} routing missing`);
    if (tile.physicalArtifactIndex !== artifactIndex) {
      throw new Error(`physical artifact ${artifactIndex} tile routing mismatch`);
    }

    setStatus(`loading and verifying physical payload ${artifactIndex}`);
    const verifiedPayload = await loadVerified(
      `./data/${payload.file}`,
      payload.bytes,
      payload.sha256,
    );
    verifiedPhysicalArtifacts.push({
      index: artifactIndex,
      file: payload.file,
      bytes: payload.bytes,
      sha256: verifiedPayload.sha256,
    });

    setStatus(`executing embedding tile ${tile.tileIndex}`);
    const result = await runTile(
      tile,
      plan,
      verifiedPayload.data,
      verifiedGraph.data,
      verifiedGraph.sha256,
      verifiedPayload.sha256,
    );
    placeRows(completeActual, result.actual, tile.positions, plan.hiddenSize);
    placeRows(completeReference, result.reference, tile.positions, plan.hiddenSize);
    executedTiles.push(result.report);
  }

  const completeEmbeddingComparison = compareExact(completeActual, completeReference);
  if (!completeEmbeddingComparison.exactEqual) {
    throw new Error(
      `complete embedding byte mismatch: firstByteMismatch=${completeEmbeddingComparison.firstByteMismatch}, maxAbsDiff=${completeEmbeddingComparison.maxAbsDiff}`,
    );
  }

  const report = {
    schemaVersion: plan.schemaVersion,
    kind: plan.runtimeReportKind,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    evidenceLevel: 'self-reported-runtime',
    userAgent: navigator.userAgent,
    adapterInfo,
    adapterLimits,
    onnxruntimeWebVersion: plan.onnxruntimeWebVersion,
    sourceGraphSha256: plan.sourceGraphSha256,
    sourceExternalData: plan.sourceExternalData,
    embeddingInitializer: plan.embeddingInitializer,
    manifestPayloadSetSha256: plan.manifestPayloadSetSha256,
    verifiedGraph: {
      file: plan.graph.file,
      bytes: plan.graph.bytes,
      sha256: verifiedGraph.sha256,
    },
    tokenIds: plan.tokenIds,
    verifiedPhysicalArtifacts,
    executedTiles,
    completeEmbeddingComparison,
    outputShape: [plan.tokenIds.length, plan.hiddenSize],
    sequentialExecution: plan.sequentialExecution,
    sessionReleaseApiCompleted: executedTiles.every((item) => item.sessionReleaseMs >= 0),
    conclusion: 'A real browser ORT Web/WebGPU run consumed the preflight-approved 8-physical embedding candidate sequentially, re-hashed the pinned graph and every payload immediately before use, executed the first and last row of each tile, assembled the complete [16,2048] result, and compared the output bytes exactly with the verified payload bytes. This remains diagnostic-only and does not select the 8-physical architecture or prove decoder/KV/checkpoint full-model equivalence, peak working set, or cancellation reclamation.',
  };
  window.__unzenEndpointEmbeddingEightPhysicalWebGpuReport = report;
  reportEl.textContent = JSON.stringify(report, null, 2);
  setStatus('pass');
}

try {
  await main();
} catch (error) {
  const report = {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-embedding-eight-physical-ort-webgpu-runtime',
    status: 'fail',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    evidenceLevel: 'self-reported-runtime',
    error: error instanceof Error ? error.message : String(error),
  };
  window.__unzenEndpointEmbeddingEightPhysicalWebGpuReport = report;
  reportEl.textContent = JSON.stringify(report, null, 2);
  setStatus('fail');
}
