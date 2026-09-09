#!/usr/bin/env node
/**
 * Capture a diagnostic OS process-RSS envelope for the isolated 8-physical
 * endpoint-embedding ORT Web/WebGPU harness.
 *
 * This does not measure WebGPU/driver allocations directly and does not select
 * the 8-physical layout. It only captures the launched Chrome process tree.
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
const EXPECTED_RUNTIME_KIND =
  'unzen-pinned-llama-1b-endpoint-embedding-eight-physical-ort-webgpu-runtime';
const EXPECTED_SCHEMA_VERSION = '1.0.0';
const EXPECTED_ORT_WEB_VERSION = '1.22.0';
const EXPECTED_ARTIFACT_COUNT = 8;
const EXPECTED_ARTIFACT_BYTES = 131_334_144;
const EXPECTED_OUTPUT_SHAPE = Object.freeze([16, 2048]);
const CANONICAL_SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_POST_REPORT_SETTLE_MS = 5000;
const DEFAULT_POST_TEARDOWN_SETTLE_MS = 30000;
const DEFAULT_TIMEOUT_MS = 180000;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireArray(value, field, length) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${field} must contain exactly ${length} entries`);
  }
  return value;
}

function requireCanonicalSha256(value, field) {
  if (typeof value !== 'string' || !CANONICAL_SHA256.test(value)) {
    throw new Error(`${field} must be a canonical lowercase SHA-256`);
  }
  return value;
}

export function validateEightPhysicalRuntimeReport(report) {
  requireObject(report, 'runtimeReport');
  if (report.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(`runtimeReport.schemaVersion must be ${EXPECTED_SCHEMA_VERSION}`);
  }
  if (report.kind !== EXPECTED_RUNTIME_KIND) {
    throw new Error(`runtimeReport.kind must be ${EXPECTED_RUNTIME_KIND}`);
  }
  if (report.status !== 'pass') throw new Error('runtimeReport.status must be pass');
  if (report.decisionStatus !== 'diagnostic-only') {
    throw new Error('runtimeReport.decisionStatus must remain diagnostic-only');
  }
  if (report.selectedPhysicalArtifactCount !== null) {
    throw new Error('runtimeReport.selectedPhysicalArtifactCount must remain null');
  }
  if (report.evidenceLevel !== 'self-reported-runtime') {
    throw new Error('runtimeReport.evidenceLevel must be self-reported-runtime');
  }
  if (report.onnxruntimeWebVersion !== EXPECTED_ORT_WEB_VERSION) {
    throw new Error(`runtimeReport.onnxruntimeWebVersion must be ${EXPECTED_ORT_WEB_VERSION}`);
  }
  if (report.sessionReleaseApiCompleted !== true) {
    throw new Error('runtimeReport.sessionReleaseApiCompleted must be true');
  }
  requireCanonicalSha256(report.manifestPayloadSetSha256, 'runtimeReport.manifestPayloadSetSha256');
  requireCanonicalSha256(report.verifiedGraph?.sha256, 'runtimeReport.verifiedGraph.sha256');

  const artifacts = requireArray(
    report.verifiedPhysicalArtifacts,
    'runtimeReport.verifiedPhysicalArtifacts',
    EXPECTED_ARTIFACT_COUNT,
  );
  const tiles = requireArray(
    report.executedTiles,
    'runtimeReport.executedTiles',
    EXPECTED_ARTIFACT_COUNT,
  );
  const seenArtifactIndexes = new Set();
  const seenTileIndexes = new Set();
  for (let index = 0; index < EXPECTED_ARTIFACT_COUNT; index += 1) {
    const artifact = requireObject(artifacts[index], `runtimeReport.verifiedPhysicalArtifacts[${index}]`);
    const tile = requireObject(tiles[index], `runtimeReport.executedTiles[${index}]`);
    const expectedFile = `payload-${String(index).padStart(4, '0')}.bin`;
    if (artifact.index !== index || seenArtifactIndexes.has(artifact.index)) {
      throw new Error(`runtimeReport verified artifact ${index} identity mismatch`);
    }
    if (artifact.file !== expectedFile || artifact.bytes !== EXPECTED_ARTIFACT_BYTES) {
      throw new Error(`runtimeReport verified artifact ${index} geometry mismatch`);
    }
    requireCanonicalSha256(artifact.sha256, `runtimeReport.verifiedPhysicalArtifacts[${index}].sha256`);
    if (tile.tileIndex !== index || tile.physicalArtifactIndex !== index || seenTileIndexes.has(tile.tileIndex)) {
      throw new Error(`runtimeReport tile ${index} routing mismatch`);
    }
    if (tile.payloadFile !== artifact.file || tile.payloadSha256 !== artifact.sha256) {
      throw new Error(`runtimeReport tile ${index} payload identity mismatch`);
    }
    if (tile.byteLength !== EXPECTED_ARTIFACT_BYTES || tile.artifactByteOffset !== 0) {
      throw new Error(`runtimeReport tile ${index} byte geometry mismatch`);
    }
    if (tile.comparison?.exactEqual !== true || tile.comparison?.firstByteMismatch !== -1) {
      throw new Error(`runtimeReport tile ${index} comparison must be byte-exact`);
    }
    if (!Number.isFinite(tile.sessionCreateMs) || tile.sessionCreateMs < 0
      || !Number.isFinite(tile.runMs) || tile.runMs < 0
      || !Number.isFinite(tile.sessionReleaseMs) || tile.sessionReleaseMs < 0) {
      throw new Error(`runtimeReport tile ${index} timing must be finite and non-negative`);
    }
    seenArtifactIndexes.add(artifact.index);
    seenTileIndexes.add(tile.tileIndex);
  }

  if (report.completeEmbeddingComparison?.exactEqual !== true
    || report.completeEmbeddingComparison?.firstByteMismatch !== -1) {
    throw new Error('runtimeReport complete embedding comparison must be byte-exact');
  }
  if (!Array.isArray(report.outputShape)
    || report.outputShape.length !== EXPECTED_OUTPUT_SHAPE.length
    || report.outputShape.some((value, index) => value !== EXPECTED_OUTPUT_SHAPE[index])) {
    throw new Error(`runtimeReport.outputShape must be [${EXPECTED_OUTPUT_SHAPE.join(',')}]`);
  }
  if (report.sequentialExecution?.tilesPerPhysicalArtifact !== 1) {
    throw new Error('runtimeReport must retain one tile per physical artifact');
  }
  return report;
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

export function parseCaptureArgs(argv, env = process.env) {
  if (argv.length < 4) {
    throw new Error(
      'usage: capture_endpoint_embedding_eight_physical_webgpu_process_rss.mjs DATA_DIR PREFLIGHT_REPORT GRAPH_PATH OUTPUT_JSON',
    );
  }
  const serverPort = parseIntegerSetting(env.UNZEN_HARNESS_PORT ?? 8797, 'UNZEN_HARNESS_PORT', 1, 65535);
  const debugPort = parseIntegerSetting(env.UNZEN_CDP_PORT ?? 9337, 'UNZEN_CDP_PORT', 1, 65535);
  if (serverPort === debugPort) {
    throw new Error('UNZEN_HARNESS_PORT and UNZEN_CDP_PORT must be distinct');
  }
  return {
    dataDir: resolve(argv[0]),
    preflightReport: resolve(argv[1]),
    graphPath: resolve(argv[2]),
    outputPath: resolve(argv[3]),
    chromeBinary: env.CHROME_BINARY || chromeDefault(env),
    serverPort,
    debugPort,
    sampleIntervalMs: parseIntegerSetting(
      env.UNZEN_RSS_SAMPLE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
      'UNZEN_RSS_SAMPLE_INTERVAL_MS',
      1,
    ),
    postReportSettleMs: parseIntegerSetting(
      env.UNZEN_RSS_POST_REPORT_SETTLE_MS ?? DEFAULT_POST_REPORT_SETTLE_MS,
      'UNZEN_RSS_POST_REPORT_SETTLE_MS',
      0,
    ),
    postTeardownSettleMs: parseIntegerSetting(
      env.UNZEN_RSS_POST_TEARDOWN_SETTLE_MS ?? DEFAULT_POST_TEARDOWN_SETTLE_MS,
      'UNZEN_RSS_POST_TEARDOWN_SETTLE_MS',
      0,
    ),
    timeoutMs: parseIntegerSetting(
      env.UNZEN_RSS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
      'UNZEN_RSS_TIMEOUT_MS',
      1,
    ),
  };
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
      // The navigation can destroy the previous execution context between polls.
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
  const profileDir = mkdtempSync(join(tmpdir(), 'unzen-eight-physical-rss-'));
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
    let runtimeReport = null;
    let immediatePostReport = null;
    while (Date.now() < deadline) {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited during capture with ${chrome.exitCode}`);
      const sample = psSnapshot(chrome.pid);
      sampleCount += 1;
      globalPeak = mergePeak(globalPeak, sample);
      let state = { phase: null, report: null };
      try {
        state = await evaluateState(cdp);
      } catch {
        // Navigation can replace the execution context between samples.
      }
      recordPhasePeak(phasePeaks, state.phase, sample);
      if (state.report?.status === 'fail') {
        throw new Error(`browser harness failed: ${state.report.error ?? 'unknown failure'}`);
      }
      if (state.report?.status === 'pass') {
        runtimeReport = validateEightPhysicalRuntimeReport(state.report);
        immediatePostReport = sample;
        break;
      }
      await sleep(config.sampleIntervalMs);
    }
    if (!runtimeReport || !immediatePostReport) {
      throw new Error('browser harness did not produce validated passing evidence before timeout');
    }

    const reportObservedAt = Date.now();
    let postReportPeak = structuredClone(immediatePostReport);
    let finalPostReport = structuredClone(immediatePostReport);
    const reportSettleDeadline = reportObservedAt + config.postReportSettleMs;
    while (Date.now() < reportSettleDeadline) {
      const remainingMs = reportSettleDeadline - Date.now();
      if (remainingMs > 0) await sleep(Math.min(config.sampleIntervalMs, remainingMs));
      const sample = psSnapshot(chrome.pid);
      sampleCount += 1;
      finalPostReport = sample;
      postReportPeak = mergePeak(postReportPeak, sample);
      globalPeak = mergePeak(globalPeak, sample);
      recordPhasePeak(phasePeaks, 'post-report-release-settle', sample);
    }

    await cdp.send('Page.navigate', { url: 'about:blank' });
    await waitForPageUrl(cdp, 'about:blank', 10000);
    const teardownStartedAt = Date.now();
    const immediatePostTeardown = psSnapshot(chrome.pid);
    sampleCount += 1;
    let postTeardownPeak = structuredClone(immediatePostTeardown);
    let postTeardownMinimum = structuredClone(immediatePostTeardown);
    let finalPostTeardown = structuredClone(immediatePostTeardown);
    let firstAtOrBelowBaseline = immediatePostTeardown.totalRssKiB <= baseline.totalRssKiB
      ? { elapsedMs: 0, ...structuredClone(immediatePostTeardown) }
      : null;
    globalPeak = mergePeak(globalPeak, immediatePostTeardown);
    recordPhasePeak(phasePeaks, 'post-teardown-about-blank', immediatePostTeardown);
    const teardownDeadline = teardownStartedAt + config.postTeardownSettleMs;
    while (Date.now() < teardownDeadline) {
      const remainingMs = teardownDeadline - Date.now();
      if (remainingMs > 0) await sleep(Math.min(config.sampleIntervalMs, remainingMs));
      const sample = psSnapshot(chrome.pid);
      sampleCount += 1;
      finalPostTeardown = sample;
      postTeardownPeak = mergePeak(postTeardownPeak, sample);
      postTeardownMinimum = mergeMinimum(postTeardownMinimum, sample);
      if (!firstAtOrBelowBaseline && sample.totalRssKiB <= baseline.totalRssKiB) {
        firstAtOrBelowBaseline = { elapsedMs: Date.now() - teardownStartedAt, ...structuredClone(sample) };
      }
      globalPeak = mergePeak(globalPeak, sample);
      recordPhasePeak(phasePeaks, 'post-teardown-about-blank', sample);
    }

    const chromeVersion = execFileSync(config.chromeBinary, ['--version'], { encoding: 'utf8' }).trim();
    const evidence = {
      schemaVersion: '1.0.0',
      kind: 'unzen-endpoint-embedding-eight-physical-webgpu-process-rss-diagnostic',
      status: 'pass',
      decisionStatus: 'diagnostic-only',
      evidenceLevel: 'captured-os-process-rss',
      capturedAtUtc: new Date().toISOString(),
      environment: {
        platform: platform(),
        osRelease: release(),
        hostTotalMemoryBytes: totalmem(),
        chromeVersion,
        nodeVersion: process.version,
        cdpBrowser: cdpVersion.Browser,
      },
      measurement: {
        metric: 'resident-set-size',
        unit: 'KiB',
        aggregation: 'sum of launched Chrome root process and descendants discovered by PPID',
        sampleIntervalMs: config.sampleIntervalMs,
        sampleCount,
        postReportSettleMs: config.postReportSettleMs,
        postDocumentTeardownSettleMs: config.postTeardownSettleMs,
        baseline,
        globalPeak,
        phasePeaks: compactPeakMap(phasePeaks),
        afterAllSessionReleaseApisReturned: {
          immediate: immediatePostReport,
          peakDuringSettle: postReportPeak,
          finalAfterSettle: finalPostReport,
        },
        afterDocumentTeardown: {
          action: 'navigate measured page to about:blank after the release settle window',
          baselineRssKiB: baseline.totalRssKiB,
          immediateAfterBlankReady: immediatePostTeardown,
          peakDuringSettle: postTeardownPeak,
          minimumDuringSettle: postTeardownMinimum,
          firstAtOrBelowBaseline,
          finalAfterSettle: finalPostTeardown,
        },
      },
      runtimeReport,
      conclusion: 'A validated 8-physical embedding WebGPU diagnostic run was observed with OS process RSS sampling before, during, and after all eight session release promises, followed by document teardown. This evidence remains diagnostic-only and does not select the 8-physical architecture or prove exact GPU allocator reclamation.',
      limitations: [
        'RSS is an OS process metric, not a WebGPU/driver allocation metric.',
        'Summing process RSS can double-count shared pages and shared-memory mappings.',
        'On unified-memory systems RSS cannot distinguish CPU-resident pages from GPU-visible shared allocations.',
        'Sampling can miss peaks shorter than the configured sample interval.',
        'A decrease after release is observational only; no GC, memory-pressure, or allocator flush is forced.',
        'Navigating to about:blank tears down the measured document but Chrome may retain renderer processes, allocator pages, driver caches, or shared mappings.',
        'This diagnostic does not select 8-physical payloads for production or prove decoder/KV/checkpoint full-model equivalence.',
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
    const config = parseCaptureArgs(process.argv.slice(2));
    const evidence = await runCapture(config);
    console.log(JSON.stringify({
      status: evidence.status,
      baselineRssKiB: evidence.measurement.baseline.totalRssKiB,
      peakRssKiB: evidence.measurement.globalPeak.totalRssKiB,
      postReleaseFinalRssKiB: evidence.measurement.afterAllSessionReleaseApisReturned.finalAfterSettle.totalRssKiB,
      postTeardownFinalRssKiB: evidence.measurement.afterDocumentTeardown.finalAfterSettle.totalRssKiB,
      output: config.outputPath,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
