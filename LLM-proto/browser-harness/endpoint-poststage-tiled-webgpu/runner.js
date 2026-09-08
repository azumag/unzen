import { validateEndpointPoststageWebGpuManifest } from './contract.js';

const statusEl = document.querySelector('#status');
const reportEl = document.querySelector('#report');
const FLOAT32_BYTES = 4;
// Cross-provider CPU ORT vs browser WebGPU diagnostic tolerance.
// CPU-vs-CPU probes remain at their stricter 1e-6 contract.
const ATOL = 1e-4;
const RTOL = 1e-4;

function setStatus(value) {
  statusEl.textContent = value;
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

function asFloat32(verified, expectedShape) {
  const expectedValues = expectedShape.reduce((product, value) => product * value, 1);
  if (verified.data.byteLength !== expectedValues * FLOAT32_BYTES) {
    throw new Error('float32 fixture geometry mismatch');
  }
  return new Float32Array(
    verified.data.buffer,
    verified.data.byteOffset,
    verified.data.byteLength / FLOAT32_BYTES,
  );
}

function compare(actual, expected) {
  if (actual.length !== expected.length) throw new Error('comparison length mismatch');
  let maxAbsDiff = 0;
  let maxRelativeDiff = 0;
  let worstIndex = -1;
  let allClose = true;
  let exactEqual = true;
  for (let index = 0; index < actual.length; index += 1) {
    const actualValue = actual[index];
    const expectedValue = expected[index];
    const diff = Math.abs(actualValue - expectedValue);
    if (diff !== 0) exactEqual = false;
    if (diff > maxAbsDiff) {
      maxAbsDiff = diff;
      worstIndex = index;
    }
    const denom = Math.max(Math.abs(expectedValue), 1e-12);
    maxRelativeDiff = Math.max(maxRelativeDiff, diff / denom);
    if (diff > ATOL + RTOL * Math.abs(expectedValue)) allClose = false;
  }
  return { allClose, exactEqual, atol: ATOL, rtol: RTOL, maxAbsDiff, maxRelativeDiff, worstIndex };
}

async function createSession(graphInfo, externalFile, externalBytes) {
  const graph = await loadVerified(
    `./data/${graphInfo.file}`,
    graphInfo.bytes,
    graphInfo.sha256,
  );
  const started = performance.now();
  const session = await ort.InferenceSession.create(graph.data, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
    externalData: [{ path: externalFile, data: externalBytes }],
  });
  return { session, sessionCreateMs: performance.now() - started };
}

async function runFinalNorm(manifest, residual, update, reference) {
  const weight = manifest.finalNorm.weight;
  const verifiedWeight = await loadVerified(
    `./data/${weight.file}`,
    weight.bytes,
    weight.sha256,
  );
  const { session, sessionCreateMs } = await createSession(
    manifest.finalNorm.graph,
    weight.file,
    verifiedWeight.data,
  );
  let runMs;
  let releaseMs;
  let actual;
  try {
    const feeds = {
      [manifest.finalNorm.inputNames[0]]: new ort.Tensor(
        'float32',
        residual,
        [1, 1, manifest.hiddenSize],
      ),
      [manifest.finalNorm.inputNames[1]]: new ort.Tensor(
        'float32',
        update,
        [1, 1, manifest.hiddenSize],
      ),
    };
    const started = performance.now();
    const outputs = await session.run(feeds);
    runMs = performance.now() - started;
    const tensor = outputs[manifest.finalNorm.outputName];
    if (!tensor) throw new Error('final norm output is missing');
    actual = new Float32Array(tensor.data);
  } finally {
    const releaseStarted = performance.now();
    await session.release();
    releaseMs = performance.now() - releaseStarted;
  }
  const comparison = compare(actual, reference);
  if (!comparison.allClose) {
    throw new Error(
      `final norm mismatch: maxAbsDiff=${comparison.maxAbsDiff}, maxRelativeDiff=${comparison.maxRelativeDiff}`,
    );
  }
  return {
    actual,
    report: {
      ...comparison,
      graphSha256: manifest.finalNorm.graph.sha256,
      weightSha256: verifiedWeight.sha256,
      sessionCreateMs,
      runMs,
      sessionReleaseMs: releaseMs,
    },
  };
}

async function runTile(tile, manifest, normalized, physical, referenceSlice) {
  const payload = physical.payload;
  const { session, sessionCreateMs } = await createSession(
    tile.graph,
    payload.file,
    physical.bytes,
  );
  let runMs;
  let releaseMs;
  let logits;
  try {
    const started = performance.now();
    const outputs = await session.run({
      [manifest.finalNorm.outputName]: new ort.Tensor(
        'float32',
        normalized,
        [1, 1, manifest.hiddenSize],
      ),
    });
    runMs = performance.now() - started;
    if (!outputs.tile_logits) throw new Error(`tile ${tile.tileIndex} logits output is missing`);
    logits = new Float32Array(outputs.tile_logits.data);
    if (logits.length !== tile.rowCount) {
      throw new Error(`tile ${tile.tileIndex} output row mismatch`);
    }
  } finally {
    const releaseStarted = performance.now();
    await session.release();
    releaseMs = performance.now() - releaseStarted;
  }
  const comparison = compare(logits, referenceSlice);
  if (!comparison.allClose) {
    throw new Error(
      `tile ${tile.tileIndex} logits mismatch: maxAbsDiff=${comparison.maxAbsDiff}, maxRelativeDiff=${comparison.maxRelativeDiff}`,
    );
  }
  return {
    logits,
    report: {
      tileIndex: tile.tileIndex,
      startRow: tile.startRow,
      endRowExclusive: tile.endRowExclusive,
      physicalArtifactIndex: tile.physicalArtifactIndex,
      artifactByteOffset: tile.artifactByteOffset,
      byteLength: tile.byteLength,
      graphSha256: tile.graph.sha256,
      comparison,
      sessionCreateMs,
      runMs,
      sessionReleaseMs: releaseMs,
    },
  };
}

async function loadFloatFixture(info) {
  const verified = await loadVerified(`./data/${info.file}`, info.bytes, info.sha256);
  return { values: asFloat32(verified, info.shape), sha256: verified.sha256 };
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
  validateEndpointPoststageWebGpuManifest(manifest);

  const [residualFixture, updateFixture, referenceNormFixture, referenceLogitsFixture] = await Promise.all([
    loadFloatFixture(manifest.inputs[manifest.finalNorm.inputNames[0]]),
    loadFloatFixture(manifest.inputs[manifest.finalNorm.inputNames[1]]),
    loadFloatFixture(manifest.referenceOutputs.finalNorm),
    loadFloatFixture(manifest.referenceOutputs.logits),
  ]);

  setStatus('executing pinned final norm');
  const finalNorm = await runFinalNorm(
    manifest,
    residualFixture.values,
    updateFixture.values,
    referenceNormFixture.values,
  );

  const completeLogits = new Float32Array(manifest.rows);
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
    const physical = { payload, bytes: verified.data };
    const tiles = manifest.tiles.filter((tile) => tile.physicalArtifactIndex === artifactIndex);
    if (tiles.length !== manifest.sequentialExecution.tilesPerPhysicalArtifact) {
      throw new Error(`physical artifact ${artifactIndex} tile count mismatch`);
    }
    for (const tile of tiles) {
      setStatus(`executing logits tile ${tile.tileIndex}`);
      const referenceSlice = referenceLogitsFixture.values.subarray(tile.startRow, tile.endRowExclusive);
      const result = await runTile(
        tile,
        manifest,
        finalNorm.actual,
        physical,
        referenceSlice,
      );
      completeLogits.set(result.logits, tile.startRow);
      executedTiles.push(result.report);
    }
  }

  const logitsComparison = compare(completeLogits, referenceLogitsFixture.values);
  if (!logitsComparison.allClose) {
    throw new Error(
      `complete logits mismatch: maxAbsDiff=${logitsComparison.maxAbsDiff}, maxRelativeDiff=${logitsComparison.maxRelativeDiff}`,
    );
  }
  const report = {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-poststage-tiled-ort-webgpu-runtime',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'self-reported-runtime',
    userAgent: navigator.userAgent,
    adapterInfo,
    adapterLimits,
    onnxruntimeWebVersion: manifest.onnxruntimeWebVersion,
    sourceGraphSha256: manifest.sourceGraphSha256,
    sourceExternalData: manifest.sourceExternalData,
    inputs: {
      residualSha256: residualFixture.sha256,
      updateSha256: updateFixture.sha256,
    },
    referenceOutputs: {
      finalNormSha256: referenceNormFixture.sha256,
      logitsSha256: referenceLogitsFixture.sha256,
      provider: manifest.referenceOnnxruntime.provider,
      onnxruntimeVersion: manifest.referenceOnnxruntime.version,
    },
    finalNorm: finalNorm.report,
    verifiedPhysicalArtifacts,
    executedTiles,
    logitsComparison,
    sequentialExecution: manifest.sequentialExecution,
    sessionReleaseApiCompleted: [finalNorm.report, ...executedTiles]
      .every((item) => item.sessionReleaseMs >= 0),
    conclusion: 'A real browser ORT Web/WebGPU run executed the pinned source final norm once and all eight preferred-payload-backed vocabulary logits tiles sequentially, then compared the complete logits tensor with a pinned-source CPU ORT reference. This remains diagnostic-only. release() completion and sequential JavaScript references do not prove immediate host/GPU memory reclamation, and this result does not select the 4-way/8-way architecture, define production cache/runtime/dispatcher semantics, or prove decoder/KV/checkpoint full-model staged equivalence.',
  };
  window.__unzenEndpointPoststageWebGpuReport = report;
  reportEl.textContent = JSON.stringify(report, null, 2);
  setStatus('pass');
}

try {
  await main();
} catch (error) {
  const report = {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-poststage-tiled-ort-webgpu-runtime',
    status: 'fail',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'self-reported-runtime',
    error: error instanceof Error ? error.message : String(error),
  };
  window.__unzenEndpointPoststageWebGpuReport = report;
  reportEl.textContent = JSON.stringify(report, null, 2);
  setStatus('fail');
}
