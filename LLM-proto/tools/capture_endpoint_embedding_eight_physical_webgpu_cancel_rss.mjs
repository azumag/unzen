#!/usr/bin/env node
/**
 * Capture diagnostic host-process RSS around coarse page-teardown cancellation
 * of the isolated 8-physical endpoint-embedding ORT Web/WebGPU harness.
 *
 * Cancellation is intentionally implemented by navigating the measured page to
 * about:blank while a selected `executing embedding tile N` phase is observed.
 * This does not claim an ORT/WebGPU in-flight cancellation API and does not
 * measure GPU allocations directly.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  mergeMinimum,
  mergePeak,
  parsePsRows,
  summarizeProcessRows,
} from './capture_endpoint_poststage_webgpu_process_rss.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LLM_PROTO_ROOT = resolve(SCRIPT_DIR, '..');
const HARNESS_SERVER = resolve(
  LLM_PROTO_ROOT,
  'browser-harness/endpoint-embedding-eight-physical-webgpu/serve.mjs',
);
const ARTIFACT_COUNT = 8;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_POST_CANCEL_SETTLE_MS = 30000;
const DEFAULT_TIMEOUT_MS = 180000;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function parseIntegerSetting(rawValue, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof rawValue === 'string' && rawValue.trim() === '') {
    throw new Error(`${name} must be an integer in ${minimum}..${maximum}; received an empty value`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer in ${minimum}..${maximum}; received ${JSON.stringify(rawValue)}`);
  }
  return value;
}

function chromeDefault(env = process.env) {
  if (platform() === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return env.CHROME_BINARY || 'google-chrome';
}

export function parseCancelCaptureArgs(argv, env = process.env) {
  if (argv.length < 5) {
    throw new Error(
      'usage: capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs DATA_DIR PREFLIGHT_REPORT GRAPH_PATH OUTPUT_JSON CANCEL_TILE',
    );
  }
  const serverPort = parseIntegerSetting(env.UNZEN_HARNESS_PORT ?? 8798, 'UNZEN_HARNESS_PORT', 1, 65535);
  const debugPort = parseIntegerSetting(env.UNZEN_CDP_PORT ?? 9338, 'UNZEN_CDP_PORT', 1, 65535);
  if (serverPort === debugPort) {
    throw new Error('UNZEN_HARNESS_PORT and UNZEN_CDP_PORT must be distinct');
  }
  return {
    dataDir: resolve(argv[0]),
    preflightReport: resolve(argv[1]),
    graphPath: resolve(argv[2]),
    outputPath: resolve(argv[3]),
    cancelTile: parseIntegerSetting(argv[4], 'CANCEL_TILE', 0, ARTIFACT_COUNT - 1),
    chromeBinary: env.CHROME_BINARY || chromeDefault(env),
    serverPort,
    debugPort,
    sampleIntervalMs: parseIntegerSetting(
      env.UNZEN_RSS_SAMPLE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
      'UNZEN_RSS_SAMPLE_INTERVAL_MS',
      1,
    ),
    postCancelSettleMs: parseIntegerSetting(
      env.UNZEN_RSS_POST_CANCEL_SETTLE_MS ?? DEFAULT_POST_CANCEL_SETTLE_MS,
      'UNZEN_RSS_POST_CANCEL_SETTLE_MS',
      0,
    ),
    timeoutMs: parseIntegerSetting(
      env.UNZEN_RSS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
      'UNZEN_RSS_TIMEOUT_MS',
      1,
    ),
  };
}

function phaseProgress(phase) {
  if (typeof phase !== 'string') return null;
  const payloadMatch = phase.match(/^loading and verifying physical payload ([0-7])$/);
  if (payloadMatch) return { tile: Number(payloadMatch[1]), step: 0 };
  const executeMatch = phase.match(/^executing embedding tile ([0-7])$/);
  if (executeMatch) return { tile: Number(executeMatch[1]), step: 1 };
  return null;
}

export function classifyCancellationObservation(state, targetTile) {
  const validatedTarget = parseIntegerSetting(targetTile, 'targetTile', 0, ARTIFACT_COUNT - 1);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('observed browser state must be an object');
  }
  const expectedPhase = `executing embedding tile ${validatedTarget}`;
  if (state.report?.status === 'fail') {
    return {
      action: 'fail',
      reason: `browser harness failed before cancellation: ${state.report.error ?? 'unknown failure'}`,
    };
  }
  if (state.report?.status === 'pass' || state.phase === 'pass') {
    return {
      action: 'fail',
      reason: `browser harness completed before cancellation phase ${expectedPhase} was observed`,
    };
  }
  if (state.phase === expectedPhase) {
    return { action: 'cancel', phase: expectedPhase, targetTile: validatedTarget };
  }

  const progress = phaseProgress(state.phase);
  if (progress && progress.tile > validatedTarget) {
    return {
      action: 'fail',
      reason: `cancellation phase ${expectedPhase} was missed; observed later phase ${state.phase}`,
    };
  }
  return { action: 'continue' };
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.addEventListener('open', () => resolvePromise());
      socket.addEventListener('error', () => reject(new Error('CDP websocket connection failed')));
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed'));
        else pending.resolve(message.result ?? {});
      });
      socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) pending.reject(new Error('CDP websocket closed'));
        this.pending.clear();
      });
    });
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('CDP websocket is not open');
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

async function assertPortAvailable(port, label) {
  await new Promise((resolvePromise, reject) => {
    const probe = createNetServer();
    probe.once('error', (error) => reject(new Error(`${label} port ${port} is unavailable: ${error.message}`)));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close((error) => (error ? reject(error) : resolvePromise()));
    });
  });
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`${label} did not become ready${lastError ? `: ${lastError}` : ''}`);
}

function psSnapshot(rootPid) {
  const text = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return summarizeProcessRows(rootPid, parsePsRows(text));
}

async function evaluateState(cdp) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      phase: window.__unzenEndpointEmbeddingEightPhysicalWebGpuPhase ?? null,
      report: window.__unzenEndpointEmbeddingEightPhysicalWebGpuReport ?? null
    })`,
    returnByValue: true,
  });
  const raw = result?.result?.value;
  if (typeof raw !== 'string') return { phase: null, report: null };
  return JSON.parse(raw);
}

async function waitForPageUrl(cdp, expectedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ href: location.href, readyState: document.readyState })',
        returnByValue: true,
      });
      const raw = result?.result?.value;
      if (typeof raw === 'string') {
        const state = JSON.parse(raw);
        if (state.href === expectedUrl && state.readyState === 'complete') return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`page did not settle at ${expectedUrl}${lastError ? `: ${lastError}` : ''}`);
}

function recordPhasePeak(phasePeaks, phase, sample) {
  const key = phase || 'pre-harness';
  phasePeaks.set(key, mergePeak(phasePeaks.get(key), sample));
}

function compactPeakMap(phasePeaks) {
  return [...phasePeaks.entries()].map(([phase, peak]) => ({ phase, ...peak }));
}

async function runCapture(config) {
  if (!['darwin', 'linux'].includes(platform())) {
    throw new Error('process RSS capture supports only macOS/Linux ps semantics');
  }
  mkdirSync(dirname(config.outputPath), { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), 'unzen-eight-physical-cancel-rss-'));
  await assertPortAvailable(config.serverPort, 'harness server');
  await assertPortAvailable(config.debugPort, 'Chrome DevTools');

  const server = spawn(process.execPath, [HARNESS_SERVER], {
    cwd: LLM_PROTO_ROOT,
    env: {
      ...process.env,
      DATA_DIR: config.dataDir,
      PREFLIGHT_REPORT: config.preflightReport,
      GRAPH_PATH: config.graphPath,
      PORT: String(config.serverPort),
    },
    stdio: 'ignore',
  });
  let chrome;
  let cdp;
  try {
    const harnessUrl = `http://127.0.0.1:${config.serverPort}/`;
    const harnessResponse = await waitFor(harnessUrl, 10000, 'harness server');
    if (server.exitCode !== null) throw new Error(`harness server exited early with ${server.exitCode}`);
    const harnessHtml = await harnessResponse.text();
    if (!harnessHtml.includes('Unzen endpoint embedding 8-physical ORT WebGPU diagnostic')) {
      throw new Error('harness server identity check failed');
    }

    chrome = spawn(config.chromeBinary, [
      '--headless=new',
      `--user-data-dir=${profileDir}`,
      '--disable-gpu-sandbox',
      '--enable-unsafe-webgpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${config.debugPort}`,
      'about:blank',
    ], { stdio: 'ignore' });
    if (!chrome.pid) throw new Error('Chrome PID unavailable');

    const versionResponse = await waitFor(
      `http://127.0.0.1:${config.debugPort}/json/version`,
      10000,
      'Chrome DevTools',
    );
    const cdpVersion = await versionResponse.json();
    if (chrome.exitCode !== null) throw new Error(`Chrome exited early with ${chrome.exitCode}`);
    const targets = await (await fetch(`http://127.0.0.1:${config.debugPort}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page' && target.url === 'about:blank');
    if (!page?.webSocketDebuggerUrl) throw new Error('about:blank CDP page target unavailable');

    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    await sleep(500);
    const baseline = psSnapshot(chrome.pid);
    let globalPeak = structuredClone(baseline);
    const phasePeaks = new Map();
    recordPhasePeak(phasePeaks, 'baseline-about-blank', baseline);
    let sampleCount = 1;

    await cdp.send('Page.navigate', { url: harnessUrl });
    const deadline = Date.now() + config.timeoutMs;
    let triggerState = null;
    let immediatelyBeforeCancellation = null;
    while (Date.now() < deadline) {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited during capture with ${chrome.exitCode}`);
      if (server.exitCode !== null) throw new Error(`harness server exited during capture with ${server.exitCode}`);
      const sample = psSnapshot(chrome.pid);
      sampleCount += 1;
      globalPeak = mergePeak(globalPeak, sample);
      let state = { phase: null, report: null };
      try {
        state = await evaluateState(cdp);
      } catch {
        await sleep(config.sampleIntervalMs);
        continue;
      }
      recordPhasePeak(phasePeaks, state.phase, sample);
      const classification = classifyCancellationObservation(state, config.cancelTile);
      if (classification.action === 'fail') throw new Error(classification.reason);
      if (classification.action === 'cancel') {
        triggerState = {
          targetTile: config.cancelTile,
          expectedPhase: `executing embedding tile ${config.cancelTile}`,
          observedPhase: state.phase,
          reportStatusAtTrigger: state.report?.status ?? null,
        };
        immediatelyBeforeCancellation = sample;
        break;
      }
      await sleep(config.sampleIntervalMs);
    }
    if (!triggerState || !immediatelyBeforeCancellation) {
      throw new Error(`cancellation phase executing embedding tile ${config.cancelTile} was not observed before timeout`);
    }

    const cancellationRequestedAt = Date.now();
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await waitForPageUrl(cdp, 'about:blank', 10000);
    const blankReadyAt = Date.now();
    const immediateAfterBlankReady = psSnapshot(chrome.pid);
    sampleCount += 1;
    globalPeak = mergePeak(globalPeak, immediateAfterBlankReady);
    let postCancelPeak = structuredClone(immediateAfterBlankReady);
    let postCancelMinimum = structuredClone(immediateAfterBlankReady);
    let finalPostCancel = structuredClone(immediateAfterBlankReady);
    let firstAtOrBelowBaseline = immediateAfterBlankReady.totalRssKiB <= baseline.totalRssKiB
      ? { elapsedMs: 0, ...structuredClone(immediateAfterBlankReady) }
      : null;
    recordPhasePeak(phasePeaks, 'post-cancel-about-blank', immediateAfterBlankReady);

    const settleStartedAt = Date.now();
    const settleDeadline = settleStartedAt + config.postCancelSettleMs;
    while (Date.now() < settleDeadline) {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited during post-cancel settle with ${chrome.exitCode}`);
      const remainingMs = settleDeadline - Date.now();
      if (remainingMs > 0) await sleep(Math.min(config.sampleIntervalMs, remainingMs));
      const sample = psSnapshot(chrome.pid);
      sampleCount += 1;
      finalPostCancel = sample;
      postCancelPeak = mergePeak(postCancelPeak, sample);
      postCancelMinimum = mergeMinimum(postCancelMinimum, sample);
      if (!firstAtOrBelowBaseline && sample.totalRssKiB <= baseline.totalRssKiB) {
        firstAtOrBelowBaseline = { elapsedMs: Date.now() - settleStartedAt, ...structuredClone(sample) };
      }
      globalPeak = mergePeak(globalPeak, sample);
      recordPhasePeak(phasePeaks, 'post-cancel-about-blank', sample);
    }

    const chromeVersion = execFileSync(config.chromeBinary, ['--version'], { encoding: 'utf8' }).trim();
    const evidence = {
      schemaVersion: '1.0.0',
      kind: 'unzen-endpoint-embedding-eight-physical-webgpu-page-teardown-cancel-rss-diagnostic',
      status: 'pass',
      decisionStatus: 'diagnostic-only',
      evidenceLevel: 'captured-os-process-rss-after-page-teardown-cancellation',
      capturedAtUtc: new Date().toISOString(),
      environment: {
        platform: platform(),
        osRelease: release(),
        hostTotalMemoryBytes: totalmem(),
        chromeVersion,
        nodeVersion: process.version,
        cdpBrowser: cdpVersion.Browser,
      },
      cancellation: {
        ...triggerState,
        method: 'CDP Page.navigate to about:blank',
        requestToBlankReadyMs: blankReadyAt - cancellationRequestedAt,
        boundary: 'coarse page teardown after observing the runner phase; exact ORT create/run progress at teardown is not asserted',
      },
      measurement: {
        metric: 'resident-set-size',
        unit: 'KiB',
        aggregation: 'sum of launched Chrome root process and descendants discovered by PPID',
        sampleIntervalMs: config.sampleIntervalMs,
        sampleCount,
        postCancelSettleMs: config.postCancelSettleMs,
        baseline,
        globalPeak,
        phasePeaks: compactPeakMap(phasePeaks),
        immediatelyBeforeCancellation,
        afterDocumentCancellation: {
          action: 'navigate measured page to about:blank as a coarse cancellation boundary',
          baselineRssKiB: baseline.totalRssKiB,
          immediateAfterBlankReady,
          peakDuringSettle: postCancelPeak,
          minimumDuringSettle: postCancelMinimum,
          firstAtOrBelowBaseline,
          finalAfterSettle: finalPostCancel,
        },
      },
      conclusion: 'The isolated 8-physical embedding harness reached the configured tile execution phase and the measured document was then torn down while host Chrome-process RSS was sampled through the post-cancel settle window. This is cancellation-path diagnostic evidence only and does not select the 8-physical architecture.',
      limitations: [
        'The runner publishes the executing-tile phase immediately before entering the async tile routine; sampling cannot prove whether teardown occurred during InferenceSession.create(), session.run(), or another point inside that routine.',
        'Page navigation is a coarse document-lifecycle cancellation mechanism, not evidence of an ORT/WebGPU in-flight cancellation API.',
        'RSS is an OS process metric, not a WebGPU/driver allocation metric.',
        'Summing process RSS can double-count shared pages and shared-memory mappings.',
        'On unified-memory systems RSS cannot distinguish CPU-resident pages from GPU-visible shared allocations.',
        'Sampling can miss peaks shorter than the configured sample interval.',
        'Chrome may retain renderer processes, allocator pages, driver caches, or shared mappings after document teardown.',
        'This diagnostic does not prove decoder/KV/checkpoint full-model equivalence or select 8-physical payloads for production.',
      ],
    };
    writeFileSync(config.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    return evidence;
  } finally {
    cdp?.close();
    if (chrome && !chrome.killed) chrome.kill('SIGTERM');
    if (!server.killed) server.kill('SIGTERM');
    await sleep(250);
    rmSync(profileDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = parseCancelCaptureArgs(process.argv.slice(2));
    const evidence = await runCapture(config);
    console.log(JSON.stringify({
      status: evidence.status,
      cancelTile: evidence.cancellation.targetTile,
      observedPhase: evidence.cancellation.observedPhase,
      baselineRssKiB: evidence.measurement.baseline.totalRssKiB,
      peakRssKiB: evidence.measurement.globalPeak.totalRssKiB,
      postCancelMinimumRssKiB: evidence.measurement.afterDocumentCancellation.minimumDuringSettle.totalRssKiB,
      postCancelFinalRssKiB: evidence.measurement.afterDocumentCancellation.finalAfterSettle.totalRssKiB,
      output: config.outputPath,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
