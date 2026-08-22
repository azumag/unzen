/**
 * WebGPU 2B SPLIT harness runner (PLAN.md 7.1 step 0 split path).
 *
 * Runs the two-segment split path (segment0: embedding + layers.0..7,
 * segment1: layers.8..16 + lm_head) on onnxruntime-web with the WebGPU
 * backend, and compares its output against the single-worker reference (the
 * full model in the same session) as the quality gate.
 *
 * URL params: `full=0` skips loading/running the full-model reference session
 * (low-load mode; the report then has no same-session reference comparison).
 *
 * Model artifacts (sliced with python onnx.utils.extract_model + external
 * data) are expected under /models/<repo>/onnx/segment0.onnx(.data) and
 * segment1.onnx(.data). The full model /models/<repo>/onnx/model_q4.onnx is
 * the reference path.
 *
 * This report is SELF-REPORTED: it is diagnostic only and must be wrapped in
 * a captured-and-verified EvidenceEnvelope before it can be treated as
 * verified evidence (see docs/evidence-readiness.md).
 */
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.all.min.mjs';
import { AutoTokenizer } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

const banner = document.getElementById('banner');
const logEl = document.getElementById('log');
const runButton = document.getElementById('run');
const reportHolder = document.getElementById('report-holder');
const reportOutput = document.getElementById('report-output');

const params = new URLSearchParams(location.search);
const MODEL = params.get('model') ?? 'onnx-community/Llama-3.2-1B-Instruct';
const PROMPT = params.get('prompt') ?? 'The capital of France is';
const requestedTokens = Number(params.get('tokens') ?? 24);
const MAX_NEW_TOKENS = Number.isFinite(requestedTokens)
  ? Math.max(1, Math.min(256, Math.trunc(requestedTokens)))
  : 24;
// `full=0` skips the full-model reference session. The split path is then
// reported without a same-session comparison (for low-load runs; the Python
// verification already proved logits equality with the full model).
const FULL_REFERENCE = params.get('full') !== '0';

const BASE = `/models/${MODEL}/onnx/`;

function setBanner(text, kind) {
  banner.textContent = text;
  banner.className = 'banner' + (kind ? ' ' + kind : '');
}

function log(message) {
  logEl.textContent += String(message) + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function showReport(report) {
  reportOutput.value = JSON.stringify(report, null, 2);
  reportHolder.classList.remove('hidden');
}

function redact(text) {
  return text.length <= 96 ? text : text.slice(0, 96) + '…';
}

async function adapterInfo() {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { error: 'no adapter' };
    return {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      isFallbackAdapter: adapter.isFallbackAdapter,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * Load a sliced model whose weights live in an external data file. The URL
 * session path cannot resolve external data (Module.MountedFiles is not
 * available), so both files are fetched and passed as ArrayBuffers.
 */
async function createSessionWithExternalData(baseUrl, dataUrl, opts) {
  const [modelBuffer, dataBuffer] = await Promise.all([
    fetch(baseUrl).then((r) => r.arrayBuffer()),
    fetch(dataUrl).then((r) => r.arrayBuffer()),
  ]);
  return ort.InferenceSession.create(modelBuffer, {
    ...opts,
    externalData: [{ path: dataUrl.split('/').pop(), data: dataBuffer }],
  });
}

/** Build the kv-cache feeds for one segment (empty caches on the first call). */
function kvFeeds(prefix, pastKeyValues, totalLen) {
  const feeds = {};
  for (let i = 0; i < 8; i += 1) {
    const cur = pastKeyValues[i];
    if (cur === undefined) {
      // First call: zero-length caches, shape [1, 8, 0, 64].
      feeds[`${prefix}${i}.key`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
      feeds[`${prefix}${i}.value`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
    } else {
      feeds[`${prefix}${i}.key`] = cur.key;
      feeds[`${prefix}${i}.value`] = cur.value;
    }
  }
  void totalLen;
  return feeds;
}

/**
 * Run the full model (reference path) for `tokens` input ids and return the
 * generated text. Greedy decoding with kv-cache reuse.
 */
async function generateFull(session, tokenizer, prompt, maxNew) {
  const enc = tokenizer(prompt, { add_special_tokens: true });
  const inputIds = Array.from(enc.input_ids.data);
  let past = new Array(16).fill(undefined);
  const outTokens = [];
  let text = '';
  const stepMs = [];
  // Step 0 is the prefill run and already yields the first generated token;
  // each following step feeds the previously generated token back in, so the
  // loop produces exactly `maxNew` tokens.
  for (let step = 0; step < maxNew; step += 1) {
    const t0 = performance.now();
    const ids = step === 0
      ? new ort.Tensor('int64', BigInt64Array.from(inputIds), [1, inputIds.length])
      : new ort.Tensor('int64', BigInt64Array.from([BigInt(outTokens[outTokens.length - 1])]), [1, 1]);
    const totalLen = step === 0 ? inputIds.length : inputIds.length + step;
    const mask = new ort.Tensor('int64', BigInt64Array.from(new Array(totalLen).fill(1n)), [1, totalLen]);
    const feeds = { input_ids: ids, attention_mask: mask };
    for (let i = 0; i < 16; i += 1) {
      const cur = past[i];
      if (cur === undefined) {
        feeds[`past_key_values.${i}.key`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
        feeds[`past_key_values.${i}.value`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
      } else {
        feeds[`past_key_values.${i}.key`] = cur.key;
        feeds[`past_key_values.${i}.value`] = cur.value;
      }
    }
    const results = await session.run(feeds);
    past = [];
    for (let i = 0; i < 16; i += 1) {
      past.push({ key: results[`present.${i}.key`], value: results[`present.${i}.value`] });
    }
    const logits = results.logits.data;
    const seqLen = step === 0 ? inputIds.length : 1;
    const vocab = 128256;
    const last = logits.slice((seqLen - 1) * vocab, seqLen * vocab);
    let best = 0;
    for (let v = 1; v < last.length; v += 1) {
      if (last[v] > last[best]) best = v;
    }
    stepMs.push(performance.now() - t0);
    if (best === tokenizer.eos_token_id) break;
    outTokens.push(best);
    text = tokenizer.decode(outTokens);
  }
  return { text, outTokens, stepMs };
}

/**
 * Run the two-segment split path and return the generated text.
 * Segment 0 -> relay 2 boundary tensors -> segment 1, per step.
 */
async function generateSplit(seg0, seg1, tokenizer, prompt, maxNew) {
  const enc = tokenizer(prompt, { add_special_tokens: true });
  const inputIds = Array.from(enc.input_ids.data);
  let past0 = new Array(8).fill(undefined);
  let past1 = new Array(8).fill(undefined);
  const outTokens = [];
  let text = '';
  const stepMs = [];
  let relayBytes = 0;
  // Step 0 is the prefill run and already yields the first generated token;
  // each following step feeds the previously generated token back in, so the
  // loop produces exactly `maxNew` tokens.
  for (let step = 0; step < maxNew; step += 1) {
    const t0 = performance.now();
    const ids = step === 0
      ? new ort.Tensor('int64', BigInt64Array.from(inputIds), [1, inputIds.length])
      : new ort.Tensor('int64', BigInt64Array.from([BigInt(outTokens[outTokens.length - 1])]), [1, 1]);
    const totalLen = step === 0 ? inputIds.length : inputIds.length + step;
    const mask = new ort.Tensor('int64', BigInt64Array.from(new Array(totalLen).fill(1n)), [1, totalLen]);
    const feeds0 = { input_ids: ids, attention_mask: mask };
    for (let i = 0; i < 8; i += 1) {
      const cur = past0[i];
      if (cur === undefined) {
        feeds0[`past_key_values.${i}.key`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
        feeds0[`past_key_values.${i}.value`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
      } else {
        feeds0[`past_key_values.${i}.key`] = cur.key;
        feeds0[`past_key_values.${i}.value`] = cur.value;
      }
    }
    const r0 = await seg0.run(feeds0);
    past0 = [];
    for (let i = 0; i < 8; i += 1) {
      past0.push({ key: r0[`present.${i}.key`], value: r0[`present.${i}.value`] });
    }
    const residual = r0['/model/layers.7/post_attention_layernorm/output_3'];
    const mlpOut = r0['/model/layers.7/mlp/down_proj/MatMul/output_0'];
    relayBytes += residual.data.byteLength + mlpOut.data.byteLength;

    const feeds1 = {
      '/model/layers.7/post_attention_layernorm/output_3': residual,
      '/model/layers.7/mlp/down_proj/MatMul/output_0': mlpOut,
      attention_mask: mask,
    };
    for (let i = 0; i < 8; i += 1) {
      const cur = past1[i];
      if (cur === undefined) {
        feeds1[`past_key_values.${i + 8}.key`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
        feeds1[`past_key_values.${i + 8}.value`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
      } else {
        feeds1[`past_key_values.${i + 8}.key`] = cur.key;
        feeds1[`past_key_values.${i + 8}.value`] = cur.value;
      }
    }
    const r1 = await seg1.run(feeds1);
    past1 = [];
    for (let i = 0; i < 8; i += 1) {
      past1.push({ key: r1[`present.${i + 8}.key`], value: r1[`present.${i + 8}.value`] });
    }
    const logits = r1.logits.data;
    const seqLen = step === 0 ? inputIds.length : 1;
    const vocab = 128256;
    const last = logits.slice((seqLen - 1) * vocab, seqLen * vocab);
    let best = 0;
    for (let v = 1; v < last.length; v += 1) {
      if (last[v] > last[best]) best = v;
    }
    stepMs.push(performance.now() - t0);
    if (best === tokenizer.eos_token_id) break;
    outTokens.push(best);
    text = tokenizer.decode(outTokens);
  }
  return { text, outTokens, stepMs, relayBytes };
}

async function run() {
  runButton.disabled = true;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  try {
    log('model: ' + MODEL);
    log('split segments: /model/layers.0-7 | /model/layers.8-16 + lm_head');
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
    log('tokenizer ready: ' + Math.round(performance.now() - t0) + 'ms');

    const ortOpts = { executionProviders: ['webgpu'] };
    const sessionPromises = [
      createSessionWithExternalData(BASE + 'segment0.onnx', BASE + 'segment0.onnx_data', ortOpts),
      createSessionWithExternalData(BASE + 'segment1.onnx', BASE + 'segment1.onnx_data', ortOpts),
    ];
    if (FULL_REFERENCE) {
      sessionPromises.push(createSessionWithExternalData(BASE + 'model_q4.onnx', BASE + 'model_q4.onnx_data', ortOpts));
    }
    const [seg0, seg1, full] = await Promise.all(sessionPromises);
    log('sessions ready (seg0, seg1' + (FULL_REFERENCE ? ', full' : '') + '): ' + Math.round(performance.now() - t0) + 'ms');

    setBanner('Generating via split path…');
    const split = await generateSplit(seg0, seg1, tokenizer, PROMPT, MAX_NEW_TOKENS);
    log('split done: ' + Math.round(performance.now() - t0) + 'ms');
    let fullRun = null;
    if (FULL_REFERENCE) {
      setBanner('Generating reference (full model)…');
      fullRun = await generateFull(full, tokenizer, PROMPT, MAX_NEW_TOKENS);
      log('reference done: ' + Math.round(performance.now() - t0) + 'ms');
    }

    const totalMs = performance.now() - t0;
    const decodeMsSplit = split.stepMs.length > 1 ? split.stepMs.slice(1) : [];
    const decodeMsFull = fullRun && fullRun.stepMs.length > 1 ? fullRun.stepMs.slice(1) : [];
    const avgSplit = decodeMsSplit.length > 0
      ? decodeMsSplit.reduce((a, b) => a + b, 0) / decodeMsSplit.length : 0;
    const avgFull = decodeMsFull.length > 0
      ? decodeMsFull.reduce((a, b) => a + b, 0) / decodeMsFull.length : 0;
    const match = fullRun ? split.text === fullRun.text : true;
    const referenceSkipped = !fullRun;
    setBanner(
      referenceSkipped
        ? `Split generated ${split.outTokens.length} tokens (reference skipped).`
        : match ? 'Split matches reference.' : 'SPLIT MISMATCH',
      referenceSkipped || match ? 'ok' : 'error',
    );
    log('split text:  ' + redact(split.text));
    if (fullRun) log('reference:   ' + redact(fullRun.text));

    showReport({
      schemaVersion: '1.0.0',
      reportKind: 'webgpu-2b-split',
      capturedAt: startedAt,
      model: MODEL,
      prompt: PROMPT,
      adapter: await adapterInfo(),
      ok: match && !referenceSkipped,
      outputMatch: fullRun ? match : null,
      referenceSkipped,
      splitOutput: redact(split.text),
      referenceOutput: fullRun ? redact(fullRun.text) : null,
      timings: {
        totalMs: Math.round(totalMs),
        maxNewTokens: MAX_NEW_TOKENS,
        splitTokens: split.outTokens.length,
        referenceTokens: fullRun ? fullRun.outTokens.length : 0,
        splitAvgDecodeMsPerToken: Math.round(avgSplit),
        referenceAvgDecodeMsPerToken: fullRun ? Math.round(avgFull) : 0,
        splitTokensPerSec: avgSplit > 0 ? Math.round(1000 / avgSplit * 10) / 10 : 0,
        referenceTokensPerSec: fullRun && avgFull > 0 ? Math.round(1000 / avgFull * 10) / 10 : 0,
        relayBytesPerStep: split.stepMs.length > 0
          ? Math.round(split.relayBytes / split.stepMs.length)
          : 0,
        relayTotalBytes: split.relayBytes,
      },
    });
  } catch (e) {
    setBanner('Failed: ' + e, 'error');
    log('ERROR: ' + (e && e.stack ? e.stack : e));
    showReport({
      schemaVersion: '1.0.0',
      reportKind: 'webgpu-2b-split',
      capturedAt: startedAt,
      model: MODEL,
      ok: false,
      error: String(e && e.message ? e.message : e),
    });
  }
  runButton.disabled = false;
}

runButton.addEventListener('click', run);
runButton.disabled = false;
setBanner('Ready. Model: ' + MODEL + ' (split path)', 'ok');
