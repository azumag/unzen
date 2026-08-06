/**
 * WebGPU 2B harness runner (PLAN.md 7.1 step 0 measurement path).
 *
 * Loads a text-generation model through transformers.js on the WebGPU
 * backend and reports self-reported measurements: model load time
 * (first run includes the ONNX artifact download), generation latency,
 * tokens/sec, adapter metadata, and a redacted output sample.
 *
 * Model is chosen from the URL query (default: the q4 variant of
 * onnx-community/Llama-3.2-1B-Instruct, ~1.7 GB ONNX data).
 *
 * This report is SELF-REPORTED: it is diagnostic only and must be wrapped in
 * a captured-and-verified EvidenceEnvelope before it can be treated as
 * verified evidence (see docs/evidence-readiness.md).
 */
import {
  env,
  pipeline,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

const banner = document.getElementById('banner');
const logEl = document.getElementById('log');
const runButton = document.getElementById('run');
const reportHolder = document.getElementById('report-holder');
const reportOutput = document.getElementById('report-output');

const params = new URLSearchParams(location.search);
// Default model verified downloadable without auth (2026-08-06): several
// onnx-community repos (e.g. SmolLM2-135M-Instruct) return 401 on this
// network, while onnx-community/Llama-3.2-1B-Instruct is reachable.
const MODEL = params.get('model') ?? 'onnx-community/Llama-3.2-1B-Instruct';
const PROMPT = params.get('prompt') ?? 'The capital of France is';
const requestedTokens = Number(params.get('tokens') ?? 32);
// Clamp so a malformed query (NaN / negative / absurd) cannot reach the model.
const MAX_NEW_TOKENS = Number.isFinite(requestedTokens)
  ? Math.max(1, Math.min(512, Math.trunc(requestedTokens)))
  : 32;

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

// Redact the model output: record the first 64 chars only; the full text
// stays in the browser and is never part of the telemetry.
function redact(text) {
  return text.length <= 64 ? text : text.slice(0, 64) + '…';
}

async function run() {
  setBanner('Loading transformers.js + model on WebGPU…');
  runButton.disabled = true;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  let generator;
  try {
    env.backends.onnx.wasm.proxy = false;
    // Local-first artifact loading: when the server exposes /models/ (see
    // serve.mjs MODELS_DIR) the model is read from disk. allowLocalModels is
    // REQUIRED here: in browsers it defaults to false (transformers.js v4
    // env.js), so without it every file would be fetched from huggingface.co.
    env.localModelPath = '/models/';
    env.allowLocalModels = true;
    log('model: ' + MODEL);
    log('device: webgpu');
    generator = await pipeline('text-generation', MODEL, {
      device: 'webgpu',
      dtype: 'q4',
    });
  } catch (e) {
    setBanner('Load failed: ' + e, 'error');
    log('LOAD ERROR: ' + (e && e.stack ? e.stack : e));
    showReport({
      schemaVersion: '1.0.0',
      reportKind: 'webgpu-2b-smoke',
      capturedAt: startedAt,
      model: MODEL,
      phase: 'load',
      ok: false,
      error: String(e && e.message ? e.message : e),
    });
    runButton.disabled = false;
    return;
  }
  const loadMs = performance.now() - t0;

  const t1 = performance.now();
  let outputText = '';
  let generationMs = 0;
  let genError = null;
  try {
    const result = await generator(PROMPT, {
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: false,
    });
    generationMs = performance.now() - t1;
    outputText = result[0].generated_text ?? '';
  } catch (e) {
    genError = String(e && e.message ? e.message : e);
    generationMs = performance.now() - t1;
    log('GEN ERROR: ' + genError);
  }

  const adapter = await adapterInfo();
  const totalMs = performance.now() - t0;
  setBanner(genError === null ? 'Done.' : 'Generation failed.', genError === null ? 'ok' : 'error');
  log('load: ' + Math.round(loadMs) + 'ms');
  log('generation: ' + Math.round(generationMs) + 'ms for ' + MAX_NEW_TOKENS + ' tokens');
  log('output sample: ' + redact(outputText));

  showReport({
    schemaVersion: '1.0.0',
    reportKind: 'webgpu-2b-smoke',
    capturedAt: startedAt,
    model: MODEL,
    phase: 'complete',
    ok: genError === null,
    adapter,
    timings: {
      loadMs: Math.round(loadMs),
      generationMs: Math.round(generationMs),
      totalMs: Math.round(totalMs),
      maxNewTokens: MAX_NEW_TOKENS,
      // Only a completed generation reports a rate; a failed run reports 0.
      // One decimal so small models (a few tok/s) are not rounded to an
      // integer.
      tokensPerSec:
        genError === null && generationMs > 0
          ? Math.round((MAX_NEW_TOKENS / generationMs) * 1000 * 10) / 10
          : 0,
    },
    outputSample: redact(outputText),
    generationError: genError,
  });
  runButton.disabled = false;
}

runButton.addEventListener('click', run);
runButton.disabled = false;
setBanner('Ready. Model: ' + MODEL, 'ok');
