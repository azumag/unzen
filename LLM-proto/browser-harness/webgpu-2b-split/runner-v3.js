import {
  AutoTokenizer,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
import {
  clearRealSplitArtifactCache,
  loadVerifiedArtifact,
} from './artifact-cache.js';

const params = new URLSearchParams(location.search);
const role = params.get('role') ?? 'segment0';
const runId = params.get('run') ?? 'demo';
const workerId = params.get('worker') ?? `${role}-${crypto.randomUUID().slice(0, 8)}`;
const modelId = params.get('model') ?? 'onnx-community/Llama-3.2-1B-Instruct';
const splitRoot = params.get('splitRoot') ?? '/models';
const kvHeads = Number(params.get('kvHeads') ?? 8);
const headSize = Number(params.get('headSize') ?? 64);

const roleEl = document.getElementById('role');
const workerEl = document.getElementById('worker');
const runEl = document.getElementById('run');
const promptEl = document.getElementById('prompt');
const executeEl = document.getElementById('execute');
const clearCacheEl = document.getElementById('clear-cache');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
roleEl.value = role;
workerEl.value = workerId;
runEl.value = runId;

function log(message) {
  logEl.textContent += `${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function status(message, ok = true) {
  statusEl.textContent = message;
  statusEl.className = ok ? 'ok' : 'error';
}

function modelUrl(relativePath) {
  const root = splitRoot.endsWith('/') ? splitRoot : `${splitRoot}/`;
  const clean = String(relativePath).replace(/^\.\//, '');
  return new URL(`${root}${clean}`, location.href).href;
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

async function registerWorker() {
  const response = await fetch('/api/workers/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId, role, adapter: await adapterInfo() }),
  });
  if (!response.ok) throw new Error(`worker registration failed: ${response.status}`);
}

async function loadManifest() {
  const response = await fetch(modelUrl('split-manifest.json'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`split manifest not found: ${response.status}`);
  const manifest = await response.json();
  if (manifest.kind !== 'unzen-real-two-segment-onnx') {
    throw new Error(`unexpected split manifest kind: ${manifest.kind}`);
  }
  if (manifest.artifactLayout !== 'per-segment-external-data') {
    throw new Error(`browser harness requires per-segment external data; got ${manifest.artifactLayout ?? 'unspecified'}`);
  }
  if (manifest.boundary?.tensorCount !== 2) {
    throw new Error('split manifest must declare exactly two boundary tensors');
  }
  return manifest;
}

function normalizeTokenIds(encoded) {
  let values = encoded?.input_ids;
  if (values && typeof values.tolist === 'function') values = values.tolist();
  if (Array.isArray(values) && Array.isArray(values[0])) values = values[0];
  if (!Array.isArray(values)) throw new Error('tokenizer did not return input_ids array');
  return values.map((value) => Number(value));
}

async function tokenize(prompt) {
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const encoded = await tokenizer(prompt, { add_special_tokens: true });
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

async function createWebGpuSession(segment, manifest) {
  if (manifest.artifactLayout !== 'per-segment-external-data') {
    throw new Error('refusing to load a non-sharded split manifest in the browser harness');
  }
  const modelArtifact = await loadVerifiedArtifact(modelUrl(segment.path), segment.sha256);
  const externalArtifacts = [];
  for (const entry of segment.externalData ?? []) {
    const artifact = await loadVerifiedArtifact(modelUrl(entry.location), entry.sha256);
    externalArtifacts.push({ entry, artifact });
  }
  if (externalArtifacts.length === 0) {
    throw new Error(`segment ${segment.index} has no external weights`);
  }

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
    session,
    artifactCache: {
      model: modelArtifact.report,
      externalData: externalArtifacts.map(({ artifact }) => artifact.report),
      allCacheHits: modelArtifact.report.cacheHit && externalArtifacts.every(({ artifact }) => artifact.report.cacheHit),
      sessionCreateMs,
    },
  };
}

async function runSegment0(manifest) {
  const prompt = promptEl.value;
  const { tokenIds } = await tokenize(prompt);
  log(`input token ids: ${tokenIds.join(',')}`);
  const segment = manifest.segments.find((entry) => entry.index === 0);
  if (!segment) throw new Error('segment 0 missing from manifest');
  const prepared = await createWebGpuSession(segment, manifest);
  log(`segment0 artifact cache: ${JSON.stringify(prepared.artifactCache)}`);
  const feeds = makeFeeds(prepared.session, tokenIds);
  const boundaryNames = manifest.boundary.tensors.map((entry) => entry.name);
  const started = performance.now();
  const outputs = await prepared.session.run(feeds, boundaryNames);
  const executionMs = performance.now() - started;
  const tensors = boundaryNames.map((name) => tensorToWire(name, outputs[name]));
  await prepared.session.release();
  const tensorBytes = tensors.reduce((sum, tensor) => sum + tensor.bytes, 0);
  log(`segment0 complete: ${executionMs.toFixed(1)}ms, boundary=${tensorBytes} bytes`);
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/checkpoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceWorkerId: workerId,
      prompt,
      inputTokenIds: tokenIds,
      segmentExecutionMs: executionMs,
      artifactCache: prepared.artifactCache,
      tensors,
      adapter: await adapterInfo(),
    }),
  });
  if (!response.ok) throw new Error(`checkpoint relay failed: ${response.status}`);
  log(`Coordinator receipt: ${JSON.stringify(await response.json())}`);
  status(`Segment 0 complete. cache=${prepared.artifactCache.allCacheHits ? 'warm' : 'cold/mixed'}`);
}

async function waitForCheckpoint() {
  for (;;) {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/checkpoint`, { cache: 'no-store' });
    if (response.status === 404) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      continue;
    }
    if (!response.ok) throw new Error(`checkpoint fetch failed: ${response.status}`);
    return response.json();
  }
}

function argmaxLastLogits(tensor) {
  const dims = tensor.dims;
  if (dims.length !== 3 || dims[0] !== 1) throw new Error(`unexpected logits shape: ${dims}`);
  const sequenceLength = dims[1];
  const vocab = dims[2];
  const start = (sequenceLength - 1) * vocab;
  let bestIndex = 0;
  let bestValue = -Infinity;
  for (let index = 0; index < vocab; index++) {
    const value = Number(tensor.data[start + index]);
    if (value > bestValue) {
      bestValue = value;
      bestIndex = index;
    }
  }
  return { tokenId: bestIndex, logit: bestValue };
}

async function runSegment1(manifest) {
  status('Waiting for Coordinator checkpoint…');
  const checkpoint = await waitForCheckpoint();
  if (checkpoint.directWorkerNetworking !== false || checkpoint.relayOwner !== 'coordinator') {
    throw new Error('checkpoint did not come from Coordinator-owned relay');
  }
  const tokenIds = checkpoint.inputTokenIds.map(Number);
  promptEl.value = checkpoint.prompt;
  log(`received checkpoint from ${checkpoint.sourceWorkerId}; token ids: ${tokenIds.join(',')}`);
  const boundary = new Map(checkpoint.tensors.map((wire) => [wire.name, tensorFromWire(wire)]));
  const segment = manifest.segments.find((entry) => entry.index === 1);
  if (!segment) throw new Error('segment 1 missing from manifest');
  const prepared = await createWebGpuSession(segment, manifest);
  log(`segment1 artifact cache: ${JSON.stringify(prepared.artifactCache)}`);
  const feeds = makeFeeds(prepared.session, tokenIds, boundary);
  const started = performance.now();
  const outputs = await prepared.session.run(feeds, [manifest.logitsOutput]);
  const executionMs = performance.now() - started;
  const logits = outputs[manifest.logitsOutput];
  const top1 = argmaxLastLogits(logits);
  await prepared.session.release();
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const tokenText = tokenizer.decode([top1.tokenId]);
  const report = {
    schemaVersion: '1.0.0',
    kind: 'unzen-real-two-browser-webgpu-split-run',
    runId,
    status: 'pass',
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
    adapter: await adapterInfo(),
    directWorkerNetworking: false,
    relayOwner: 'coordinator',
    artifactLayout: manifest.artifactLayout,
    segmentExternalData: segment.externalData,
  };
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
  });
  if (!response.ok) throw new Error(`result upload failed: ${response.status}`);
  log(JSON.stringify(report, null, 2));
  status(`Split inference complete. next=${JSON.stringify(tokenText)}, cache=${prepared.artifactCache.allCacheHits ? 'warm' : 'cold/mixed'}`);
}

async function execute() {
  executeEl.disabled = true;
  logEl.textContent = '';
  try {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser');
    await registerWorker();
    const manifest = await loadManifest();
    if (role === 'segment0') await runSegment0(manifest);
    else if (role === 'segment1' || role === 'standby') await runSegment1(manifest);
    else throw new Error(`unsupported role in runner: ${role}`);
  } catch (error) {
    console.error(error);
    log(error?.stack ?? String(error));
    status(`Failed: ${error?.message ?? error}`, false);
  } finally {
    executeEl.disabled = false;
  }
}

executeEl.addEventListener('click', execute);
clearCacheEl?.addEventListener('click', async () => {
  clearCacheEl.disabled = true;
  try {
    const removed = await clearRealSplitArtifactCache();
    status(removed ? 'Split artifact cache cleared.' : 'No split artifact cache was present.');
  } catch (error) {
    status(`Cache clear failed: ${error?.message ?? error}`, false);
  } finally {
    clearCacheEl.disabled = false;
  }
});
status('Ready. First run should be cold; repeat with another run ID for warm-cache measurement.');
