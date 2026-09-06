import {
  AutoTokenizer,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
import {
  clearRealSplitArtifactCache,
  loadVerifiedArtifact,
} from './artifact-cache.js';
import {
  planSegmentArtifactBudget,
  verifyActualSegmentArtifactBudget,
} from './artifact-budget.js';
import {
  argmaxLastLogits,
  validateCheckpointBoundaryNames,
} from './runtime-validation.js';
import {
  SMOLLM2_P0_CONTRACT,
  validateSmolLm2P0Manifest,
  validateSmolLm2P0RuntimeParameters,
} from './p0-manifest-contract.js';
import {
  CheckpointWaitTimeoutError,
  ownSession,
  throwIfAborted,
  waitForCheckpointBounded,
} from './execution-lifecycle.js';

const params = new URLSearchParams(location.search);
const role = params.get('role') ?? 'segment0';
const runId = params.get('run') ?? 'demo';
const workerId = params.get('worker') ?? `${role}-${crypto.randomUUID().slice(0, 8)}`;
const modelId = params.get('model') ?? 'onnx-community/Llama-3.2-1B-Instruct';
const splitRoot = params.get('splitRoot') ?? '/models';
const kvHeads = Number(params.get('kvHeads') ?? 8);
const headSize = Number(params.get('headSize') ?? 64);
const artifactBudgetMode = params.get('artifactBudget') ?? 'absolute';
const checkpointWaitMs = Number(params.get('checkpointWaitMs') ?? 120_000);

if (artifactBudgetMode === 'p0') {
  validateSmolLm2P0RuntimeParameters({ modelId, kvHeads, headSize });
}

if (!Number.isFinite(checkpointWaitMs) || checkpointWaitMs <= 0) {
  throw new Error(`checkpointWaitMs must be a positive number: ${params.get('checkpointWaitMs')}`);
}

const roleEl = document.getElementById('role');
const workerEl = document.getElementById('worker');
const runEl = document.getElementById('run');
const promptEl = document.getElementById('prompt');
const executeEl = document.getElementById('execute');
const stopEl = document.getElementById('stop');
const clearCacheEl = document.getElementById('clear-cache');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
roleEl.value = role;
workerEl.value = workerId;
runEl.value = runId;

let currentExecution;

function log(message) {
  logEl.textContent += `${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function status(message, kind = 'ok') {
  statusEl.textContent = message;
  statusEl.className = kind;
}

function modelUrl(relativePath) {
  const root = splitRoot.endsWith('/') ? splitRoot : `${splitRoot}/`;
  const clean = String(relativePath).replace(/^\.\//, '');
  return new URL(`${root}${clean}`, location.href).href;
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(bytes) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function adapterInfo() {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { error: 'no-webgpu-adapter' };
    return {
      vendor: adapter.info?.vendor ?? '',
      architecture: adapter.info?.architecture ?? '',
      description: adapter.info?.description ?? '',
      isFallbackAdapter: adapter.isFallbackAdapter ?? false,
    };
  } catch (error) {
    return { error: String(error) };
  }
}

async function registerWorker(signal) {
  throwIfAborted(signal);
  const response = await fetch('/api/workers/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId, role, adapter: await adapterInfo() }),
    signal,
  });
  throwIfAborted(signal);
  if (!response.ok) throw new Error(`worker registration failed: ${response.status}`);
}

async function loadManifest(signal) {
  throwIfAborted(signal);
  const response = await fetch(modelUrl('split-manifest.json'), { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`split manifest not found: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  throwIfAborted(signal);
  const manifestDigest = await sha256Bytes(bytes);
  throwIfAborted(signal);
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  if (manifest.kind !== 'unzen-real-two-segment-onnx') {
    throw new Error(`unexpected split manifest kind: ${manifest.kind}`);
  }
  if (manifest.artifactLayout !== 'per-segment-external-data') {
    throw new Error(`browser harness requires per-segment external data; got ${manifest.artifactLayout ?? 'unspecified'}`);
  }
  if (manifest.boundary?.tensorCount !== 2) {
    throw new Error('split manifest must declare exactly two boundary tensors');
  }
  if (artifactBudgetMode === 'p0') {
    const p0Contract = validateSmolLm2P0Manifest(manifest);
    log(`P0 manifest provenance: ${p0Contract.modelId}@${p0Contract.modelRevision}, source=${p0Contract.sourceGraphSha256}`);
  }
  return { manifest, manifestDigest };
}

function normalizeTokenIds(encoded) {
  let values = encoded?.input_ids;
  if (values && typeof values.tolist === 'function') values = values.tolist();
  if (Array.isArray(values) && Array.isArray(values[0])) values = values[0];
  if (!Array.isArray(values)) throw new Error('tokenizer did not return input_ids array');
  return values.map((value) => Number(value));
}

async function loadTokenizer() {
  const options = artifactBudgetMode === 'p0'
    ? { revision: SMOLLM2_P0_CONTRACT.modelRevision }
    : {};
  return AutoTokenizer.from_pretrained(modelId, options);
}

async function tokenize(prompt, signal) {
  throwIfAborted(signal);
  const tokenizer = await loadTokenizer();
  throwIfAborted(signal);
  const encoded = await tokenizer(prompt, { add_special_tokens: true });
  throwIfAborted(signal);
  return { tokenizer, tokenIds: normalizeTokenIds(encoded) };
}

function typedArrayFor(type, length) {
  switch (type) {
    case 'float32': return new Float32Array(length);
    case 'float64': return new Float64Array(length);
    case 'float16': return new Uint16Array(length);
    case 'int64': return new BigInt64Array(length);
    case 'int32': return new Int32Array(length);
    case 'int16': return new Int16Array(length);
    case 'int8': return new Int8Array(length);
    case 'uint64': return new BigUint64Array(length);
    case 'uint32': return new Uint32Array(length);
    case 'uint16': return new Uint16Array(length);
    case 'uint8': return new Uint8Array(length);
    case 'bool': return new Uint8Array(length);
    default: throw new Error(`unsupported tensor type: ${type}`);
  }
}

function resolveDimension(value, { name, axis, sequenceLength }) {
  if (Number.isInteger(value) && value >= 0) return value;
  const text = String(value ?? '').toLowerCase();
  if (text.includes('batch')) return 1;
  if (text.includes('num_key_value_heads')) return kvHeads;
  if (text.includes('head_size') || text.includes('head_dim')) return headSize;
  if (text.includes('past')) return 0;
  if ((text.includes('head') && !text.includes('size')) || (axis === 1 && /past|key_values/.test(name))) return kvHeads;
  if (axis === 3 && /past|key_values/.test(name)) return headSize;
  if (text.includes('sequence') || text.includes('seq')) return /past|key_values/.test(name) ? 0 : sequenceLength;
  if (/past|key_values/.test(name)) return [1, kvHeads, 0, headSize][axis] ?? 0;
  throw new Error(`cannot resolve dimension ${value} for ${name} axis ${axis}`);
}

function emptyTensorFromMetadata(meta, sequenceLength) {
  if (!meta?.isTensor) throw new Error(`non-tensor model input is unsupported: ${meta?.name}`);
  const dims = meta.shape.map((value, axis) => resolveDimension(value, {
    name: meta.name,
    axis,
    sequenceLength,
  }));
  const length = dims.reduce((product, value) => product * value, 1);
  return new ort.Tensor(meta.type, typedArrayFor(meta.type, length), dims);
}

function int64Tensor(values, dims) {
  return new ort.Tensor('int64', BigInt64Array.from(values, (value) => BigInt(value)), dims);
}

function makeFeeds(session, tokenIds, boundary = new Map()) {
  const sequenceLength = tokenIds.length;
  const feeds = {};
  session.inputNames.forEach((name, index) => {
    const meta = session.inputMetadata[index];
    if (boundary.has(name)) {
      feeds[name] = boundary.get(name);
    } else if (name === 'input_ids' || name.endsWith('/input_ids')) {
      feeds[name] = int64Tensor(tokenIds, [1, sequenceLength]);
    } else if (name.includes('attention_mask')) {
      feeds[name] = int64Tensor(new Array(sequenceLength).fill(1), [1, sequenceLength]);
    } else if (name.includes('position_ids')) {
      feeds[name] = int64Tensor(Array.from({ length: sequenceLength }, (_, value) => value), [1, sequenceLength]);
    } else if (name.includes('past_key_values') || name.startsWith('past.') || name.includes('/past')) {
      feeds[name] = emptyTensorFromMetadata(meta, sequenceLength);
    } else {
      throw new Error(`no feed builder for ${name}: ${JSON.stringify(meta)}`);
    }
  });
  return feeds;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function tensorToWire(name, tensor) {
  const bytes = new Uint8Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength);
  return { name, type: tensor.type, dims: tensor.dims, bytes: bytes.byteLength, base64: bytesToBase64(bytes) };
}

function tensorFromWire(wire) {
  const bytes = base64ToBytes(wire.base64);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let data;
  switch (wire.type) {
    case 'float32': data = new Float32Array(buffer); break;
    case 'float64': data = new Float64Array(buffer); break;
    case 'float16': data = new Uint16Array(buffer); break;
    case 'int64': data = new BigInt64Array(buffer); break;
    case 'int32': data = new Int32Array(buffer); break;
    case 'int16': data = new Int16Array(buffer); break;
    case 'int8': data = new Int8Array(buffer); break;
    case 'uint64': data = new BigUint64Array(buffer); break;
    case 'uint32': data = new Uint32Array(buffer); break;
    case 'uint16': data = new Uint16Array(buffer); break;
    case 'uint8': case 'bool': data = new Uint8Array(buffer); break;
    default: throw new Error(`unsupported relayed tensor type: ${wire.type}`);
  }
  return new ort.Tensor(wire.type, data, wire.dims);
}

async function createWebGpuSession(segment, manifest, signal) {
  if (manifest.artifactLayout !== 'per-segment-external-data') {
    throw new Error('refusing to load a non-sharded split manifest in the browser harness');
  }
  throwIfAborted(signal);

  const budgetPlan = planSegmentArtifactBudget(segment, artifactBudgetMode);
  let remainingBytes = budgetPlan.requiredMaxBytes;
  const modelArtifact = await loadVerifiedArtifact(modelUrl(segment.path), segment.sha256, {
    maxBytes: Math.min(remainingBytes, budgetPlan.graphDeclaredBytes),
    expectedBytes: budgetPlan.graphDeclaredBytes,
    signal,
  });
  remainingBytes -= modelArtifact.report.bytes;

  const externalArtifacts = [];
  for (const entry of segment.externalData ?? []) {
    throwIfAborted(signal);
    const expectedBytes = Number(entry.bytes);
    const artifact = await loadVerifiedArtifact(modelUrl(entry.location), entry.sha256, {
      maxBytes: Math.min(remainingBytes, expectedBytes),
      expectedBytes,
      signal,
    });
    remainingBytes -= artifact.report.bytes;
    externalArtifacts.push({ entry, artifact });
  }
  if (externalArtifacts.length === 0) {
    throw new Error(`segment ${segment.index} has no external weights`);
  }

  const budget = verifyActualSegmentArtifactBudget(
    budgetPlan,
    [modelArtifact.report, ...externalArtifacts.map(({ artifact }) => artifact.report)],
  );
  throwIfAborted(signal);

  const createStarted = performance.now();
  ort.env.logLevel = 'warning';
  const session = await ort.InferenceSession.create(modelArtifact.bytes, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
    externalData: externalArtifacts.map(({ entry, artifact }) => ({
      path: entry.location,
      data: artifact.bytes,
    })),
  });
  const sessionCreateMs = Math.round((performance.now() - createStarted) * 10) / 10;
  return {
    sessionOwner: ownSession(session),
    artifactCache: {
      model: modelArtifact.report,
      externalData: externalArtifacts.map(({ artifact }) => artifact.report),
      allCacheHits: modelArtifact.report.cacheHit && externalArtifacts.every(({ artifact }) => artifact.report.cacheHit),
      budget,
      sessionCreateMs,
    },
  };
}

async function runSegment0(manifest, manifestDigest, signal) {
  const prompt = promptEl.value;
  const { tokenIds } = await tokenize(prompt, signal);
  log(`input token ids: ${tokenIds.join(',')}`);
  log(`manifest sha256: ${manifestDigest}`);
  const segment = manifest.segments.find((entry) => entry.index === 0);
  if (!segment) throw new Error('segment 0 missing from manifest');
  const prepared = await createWebGpuSession(segment, manifest, signal);
  log(`segment0 artifact cache: ${JSON.stringify(prepared.artifactCache)}`);
  try {
    const feeds = makeFeeds(prepared.sessionOwner.session, tokenIds);
    throwIfAborted(signal);
    const boundaryNames = manifest.boundary.tensors.map((entry) => entry.name);
    const started = performance.now();
    const outputs = await prepared.sessionOwner.session.run(feeds, boundaryNames);
    const executionMs = performance.now() - started;
    throwIfAborted(signal);
    const tensors = boundaryNames.map((name) => tensorToWire(name, outputs[name]));
    const tensorBytes = tensors.reduce((sum, tensor) => sum + tensor.bytes, 0);
    await prepared.sessionOwner.release();
    throwIfAborted(signal);
    log(`segment0 complete: ${executionMs.toFixed(1)}ms, boundary=${tensorBytes} bytes`);
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceWorkerId: workerId,
        manifestDigest,
        prompt,
        inputTokenIds: tokenIds,
        segmentExecutionMs: executionMs,
        artifactCache: prepared.artifactCache,
        tensors,
        adapter: await adapterInfo(),
      }),
      signal,
    });
    throwIfAborted(signal);
    if (!response.ok) throw new Error(`checkpoint relay failed: ${response.status}`);
    const receipt = await response.json();
    throwIfAborted(signal);
    if (receipt.manifestDigest !== manifestDigest || !receipt.checkpointId || !receipt.checkpointDigest) {
      throw new Error('Coordinator checkpoint receipt is not bound to the loaded manifest');
    }
    log(`Coordinator receipt: ${JSON.stringify(receipt)}`);
    status(`Segment 0 complete. checkpoint=${receipt.checkpointId}, cache=${prepared.artifactCache.allCacheHits ? 'warm' : 'cold/mixed'}, artifact budget=${prepared.artifactCache.budget.verdict}`);
  } finally {
    await prepared.sessionOwner.release();
  }
}

async function waitForCheckpoint(signal) {
  return waitForCheckpointBounded({
    signal,
    timeoutMs: checkpointWaitMs,
    pollIntervalMs: 500,
    fetchCheckpoint: (fetchSignal) => fetch(
      `/api/runs/${encodeURIComponent(runId)}/checkpoint`,
      { cache: 'no-store', signal: fetchSignal },
    ),
  });
}

async function runSegment1(manifest, manifestDigest, signal) {
  status(`Waiting for Coordinator checkpoint (max ${checkpointWaitMs}ms)…`, 'pending');
  const checkpoint = await waitForCheckpoint(signal);
  throwIfAborted(signal);
  if (checkpoint.directWorkerNetworking !== false || checkpoint.relayOwner !== 'coordinator') {
    throw new Error('checkpoint did not come from Coordinator-owned relay');
  }
  if (checkpoint.manifestDigest !== manifestDigest) {
    throw new Error(`checkpoint manifest digest mismatch: ${checkpoint.manifestDigest ?? 'missing'} != ${manifestDigest}`);
  }
  if (!checkpoint.checkpointId || !checkpoint.checkpointDigest || !Number.isSafeInteger(checkpoint.sourceWorkerIdentity?.generation)) {
    throw new Error('checkpoint is missing immutable Coordinator binding metadata');
  }
  validateCheckpointBoundaryNames(checkpoint, manifest);
  const tokenIds = checkpoint.inputTokenIds.map(Number);
  promptEl.value = checkpoint.prompt;
  log(`received checkpoint ${checkpoint.checkpointId} (${checkpoint.checkpointDigest}) from ${checkpoint.sourceWorkerId}; token ids: ${tokenIds.join(',')}`);
  const boundary = new Map(checkpoint.tensors.map((wire) => [wire.name, tensorFromWire(wire)]));
  const segment = manifest.segments.find((entry) => entry.index === 1);
  if (!segment) throw new Error('segment 1 missing from manifest');
  const prepared = await createWebGpuSession(segment, manifest, signal);
  log(`segment1 artifact cache: ${JSON.stringify(prepared.artifactCache)}`);
  try {
    const feeds = makeFeeds(prepared.sessionOwner.session, tokenIds, boundary);
    throwIfAborted(signal);
    const started = performance.now();
    const outputs = await prepared.sessionOwner.session.run(feeds, [manifest.logitsOutput]);
    const executionMs = performance.now() - started;
    throwIfAborted(signal);
    const logits = outputs[manifest.logitsOutput];
    if (!logits) throw new Error(`missing logits output: ${manifest.logitsOutput}`);
    const top1 = argmaxLastLogits(logits);
    await prepared.sessionOwner.release();
    throwIfAborted(signal);
    const tokenizer = await loadTokenizer();
    throwIfAborted(signal);
    const tokenText = tokenizer.decode([top1.tokenId]);
    const report = {
      schemaVersion: '1.0.0',
      kind: 'unzen-real-two-browser-webgpu-split-run',
      runId,
      status: 'pass',
      manifestDigest,
      checkpointId: checkpoint.checkpointId,
      checkpointDigest: checkpoint.checkpointDigest,
      checkpointSourceWorkerGeneration: checkpoint.sourceWorkerIdentity.generation,
      segment0WorkerId: checkpoint.sourceWorkerId,
      segment1WorkerId: workerId,
      segment1Role: role,
      inputTokenIds: tokenIds,
      boundaryBytes: checkpoint.tensors.reduce((sum, tensor) => sum + Number(tensor.bytes), 0),
      segment0ExecutionMs: checkpoint.segmentExecutionMs,
      segment1ExecutionMs: executionMs,
      artifactCache: {
        segment0: checkpoint.artifactCache,
        segment1: prepared.artifactCache,
      },
      top1TokenId: top1.tokenId,
      top1Logit: top1.logit,
      tokenText,
      logitsShape: logits.dims,
      logitsFinite: true,
      logitsElementCount: top1.elementCount,
      adapter: await adapterInfo(),
      directWorkerNetworking: false,
      relayOwner: 'coordinator',
      artifactLayout: manifest.artifactLayout,
      segmentExternalData: segment.externalData,
    };
    throwIfAborted(signal);
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      signal,
    });
    throwIfAborted(signal);
    if (!response.ok) throw new Error(`result upload failed: ${response.status}`);
    const accepted = await response.json();
    throwIfAborted(signal);
    if (accepted.profileIsolationConfirmed !== true) {
      throw new Error('Coordinator did not confirm browser profile isolation');
    }
    if (accepted.checkpointId !== checkpoint.checkpointId || accepted.checkpointDigest !== checkpoint.checkpointDigest) {
      throw new Error('Coordinator accepted result against a different checkpoint binding');
    }
    log(JSON.stringify(report, null, 2));
    log(`Coordinator result digest: ${accepted.resultDigest}`);
    log(`Coordinator profile isolation evidence: ${JSON.stringify(accepted.profileIsolationEvidence, null, 2)}`);
    status(`Split inference complete. checkpoint=${checkpoint.checkpointId}, next=${JSON.stringify(tokenText)}, cache=${prepared.artifactCache.allCacheHits ? 'warm' : 'cold/mixed'}, artifact budget=${prepared.artifactCache.budget.verdict}, profile isolation=confirmed`);
  } finally {
    await prepared.sessionOwner.release();
  }
}

async function execute() {
  if (currentExecution) return;
  const controller = new AbortController();
  currentExecution = { controller, stopRequested: false };
  executeEl.disabled = true;
  stopEl.disabled = false;
  clearCacheEl.disabled = true;
  logEl.textContent = '';
  status('Running…', 'pending');
  try {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser');
    await registerWorker(controller.signal);
    const { manifest, manifestDigest } = await loadManifest(controller.signal);
    if (role === 'segment0') await runSegment0(manifest, manifestDigest, controller.signal);
    else if (role === 'segment1' || role === 'standby') await runSegment1(manifest, manifestDigest, controller.signal);
    else throw new Error(`unsupported role in runner: ${role}`);
  } catch (error) {
    if (error?.name === 'AbortError') {
      log('Execution stopped. Any in-flight ORT call was allowed to return before session release; no later checkpoint/result post was started.');
      status('Stopped. Safe to retry with a new run ID.', 'stopped');
    } else if (error instanceof CheckpointWaitTimeoutError) {
      log(error.message);
      status(`Timed out waiting for checkpoint after ${checkpointWaitMs}ms. Safe to retry with a new run ID.`, 'error');
    } else {
      console.error(error);
      log(error?.stack ?? String(error));
      status(`Failed: ${error?.message ?? error}`, 'error');
    }
  } finally {
    currentExecution = undefined;
    executeEl.disabled = false;
    stopEl.disabled = true;
    clearCacheEl.disabled = false;
  }
}

function stopExecution() {
  if (!currentExecution || currentExecution.controller.signal.aborted) return;
  currentExecution.stopRequested = true;
  stopEl.disabled = true;
  status('Stop requested. Waiting for the current operation/ORT call to return so resources can be released…', 'pending');
  currentExecution.controller.abort();
}

executeEl.addEventListener('click', execute);
stopEl?.addEventListener('click', stopExecution);
clearCacheEl?.addEventListener('click', async () => {
  clearCacheEl.disabled = true;
  try {
    const removed = await clearRealSplitArtifactCache();
    status(removed ? 'Split artifact cache cleared.' : 'No split artifact cache was present.');
  } catch (error) {
    status(`Cache clear failed: ${error?.message ?? error}`, 'error');
  } finally {
    clearCacheEl.disabled = false;
  }
});
status(`Ready. Checkpoint wait limit=${checkpointWaitMs}ms. Run IDs are immutable; use a new run ID for every fresh cold/warm or retry execution.`);
