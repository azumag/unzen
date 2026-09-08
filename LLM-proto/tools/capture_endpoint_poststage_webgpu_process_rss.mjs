#!/usr/bin/env node
/**
 * Capture a diagnostic process-RSS envelope for the complete endpoint post-stage
 * ORT Web/WebGPU harness introduced for #223.
 *
 * This intentionally measures OS process resident-set size, not GPU allocations.
 * On unified-memory systems RSS can include shared pages and summing processes can
 * double-count them. release() completion plus a later RSS sample therefore does
 * not prove immediate Metal/WebGPU allocator reclamation.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LLM_PROTO_ROOT = resolve(SCRIPT_DIR, '..');
const HARNESS_SERVER = resolve(
  LLM_PROTO_ROOT,
  'browser-harness/endpoint-poststage-tiled-webgpu/serve.mjs',
);
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_POST_REPORT_SETTLE_MS = 5000;
const DEFAULT_POST_TEARDOWN_SETTLE_MS = 30000;
const DEFAULT_TIMEOUT_MS = 120000;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function parsePsRows(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKiB: Number(match[3]),
      command: match[4],
    });
  }
  return rows;
}

export function descendantRows(rootPid, rows) {
  const wanted = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!wanted.has(row.pid) && wanted.has(row.ppid)) {
        wanted.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => wanted.has(row.pid));
}

export function classifyChromeProcess(row, rootPid) {
  if (row.pid === rootPid) return 'browser';
  const match = row.command.match(/(?:^|\s)--type=([^\s]+)/);
  if (!match) return 'browser-child';
  if (match[1] === 'gpu-process') return 'gpu-process';
  if (match[1] === 'renderer') return 'renderer';
  if (match[1] === 'utility') {
    const utility = row.command.match(/(?:^|\s)--utility-sub-type=([^\s]+)/)?.[1] ?? '';
    if (utility.includes('network')) return 'utility-network';
    return 'utility';
  }
  return match[1];
}

export function summarizeProcessRows(rootPid, rows) {
  const descendants = descendantRows(rootPid, rows);
  const roles = {};
  let totalRssKiB = 0;
  for (const row of descendants) {
    totalRssKiB += row.rssKiB;
    const role = classifyChromeProcess(row, rootPid);
    const current = roles[role] ?? { processCount: 0, rssKiB: 0 };
    current.processCount += 1;
    current.rssKiB += row.rssKiB;
    roles[role] = current;
  }
  return { processCount: descendants.length, totalRssKiB, roles };
}

export function mergePeak(current, sample) {
  if (!current || sample.totalRssKiB > current.totalRssKiB) {
    return structuredClone(sample);
  }
  return current;
}

export function mergeMinimum(current, sample) {
  if (!current || sample.totalRssKiB < current.totalRssKiB) {
    return structuredClone(sample);
  }
  return current;
}

function psSnapshot(rootPid) {
  const text = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return summarizeProcessRows(rootPid, parsePsRows(text));
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
        for (const pending of this.pending.values()) {
          pending.reject(new Error('CDP websocket closed'));
        }
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
      probe.close((error) => {
        if (error) reject(error);
        else resolvePromise();
      });
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

async function evaluateState(cdp) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      phase: window.__unzenEndpointPoststageWebGpuPhase ?? null,
      report: window.__unzenEndpointPoststageWebGpuReport ?? null
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

function chromeDefault() {
  if (platform() === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return process.env.CHROME_BINARY || 'google-chrome';
}

function recordPhasePeak(phasePeaks, phase, sample) {
  const key = phase || 'pre-harness';
  const current = phasePeaks.get(key);
  phasePeaks.set(key, mergePeak(current, sample));
}

function compactPeakMap(phasePeaks) {
  return [...phasePeaks.entries()].map(([phase, peak]) => ({ phase, ...peak }));
}

async function runCapture({
  dataDir,
  outputPath,
  chromeBinary,
  serverPort,
  debugPort,
  sampleIntervalMs,
  postReportSettleMs,
  postTeardownSettleMs,
  timeoutMs,
}) {
  if (!['darwin', 'linux'].includes(platform())) {
    throw new Error('process RSS capture supports only macOS/Linux ps semantics');
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-poststage-rss-'));
  await assertPortAvailable(serverPort, 'harness server');
  await assertPortAvailable(debugPort, 'Chrome DevTools');

  const server = spawn(process.execPath, [HARNESS_SERVER], {
    cwd: LLM_PROTO_ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(serverPort) },
    stdio: 'ignore',
  });
  let chrome;
  let cdp;
  try {
    const harnessUrl = `http://127.0.0.1:${serverPort}/`;
    const harnessResponse = await waitFor(harnessUrl, 10000, 'harness server');
    if (server.exitCode !== null) throw new Error(`harness server exited early with ${server.exitCode}`);
    const harnessHtml = await harnessResponse.text();
    if (!harnessHtml.includes('Unzen endpoint post-stage tiled ORT WebGPU diagnostic')) {
      throw new Error('harness server identity check failed');
    }

    chrome = spawn(chromeBinary, [
      '--headless=new',
      `--user-data-dir=${profileDir}`,
      '--disable-gpu-sandbox',
      '--enable-unsafe-webgpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${debugPort}`,
      'about:blank',
    ], { stdio: 'ignore' });
    if (!chrome.pid) throw new Error('Chrome PID unavailable');

    const versionResponse = await waitFor(
      `http://127.0.0.1:${debugPort}/json/version`,
      10000,
      'Chrome DevTools',
    );
    const cdpVersion = await versionResponse.json();
    if (chrome.exitCode !== null) throw new Error(`Chrome exited early with ${chrome.exitCode}`);
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
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
    const deadline = Date.now() + timeoutMs;
    let runtimeReport = null;
    let immediatePostReport = null;
    while (Date.now() < deadline) {
      const sample = psSnapshot(chrome.pid);
      sampleCount += 1;
      globalPeak = mergePeak(globalPeak, sample);
      let state = { phase: null, report: null };
      try {
        state = await evaluateState(cdp);
      } catch {
        // Navigation may replace the execution context between samples.
      }
      recordPhasePeak(phasePeaks, state.phase, sample);
      if (state.report?.status === 'fail') {
        throw new Error(`browser harness failed: ${state.report.error ?? 'unknown failure'}`);
      }
      if (state.report?.status === 'pass') {
        runtimeReport = state.report;
        immediatePostReport = sample;
        break;
      }
      await sleep(sampleIntervalMs);
    }
    if (!runtimeReport || !immediatePostReport) {
      throw new Error('browser harness did not produce a passing runtime report before timeout');
    }
    if (runtimeReport.decisionStatus !== 'diagnostic-only') {
      throw new Error('browser runtime evidence must remain diagnostic-only');
    }

    let postReportPeak = structuredClone(immediatePostReport);
    const settleDeadline = Date.now() + postReportSettleMs;
    let finalPostReport = structuredClone(immediatePostReport);
    while (Date.now() < settleDeadline) {
      await sleep(sampleIntervalMs);
      const sample = psSnapshot(chrome.pid);
      sampleCount += 1;
      finalPostReport = sample;
      postReportPeak = mergePeak(postReportPeak, sample);
      globalPeak = mergePeak(globalPeak, sample);
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
    const teardownDeadline = teardownStartedAt + postTeardownSettleMs;
    while (Date.now() < teardownDeadline) {
      await sleep(sampleIntervalMs);
      const sample = psSnapshot(chrome.pid);
      sampleCount += 1;
      finalPostTeardown = sample;
      postTeardownPeak = mergePeak(postTeardownPeak, sample);
      postTeardownMinimum = mergeMinimum(postTeardownMinimum, sample);
      if (!firstAtOrBelowBaseline && sample.totalRssKiB <= baseline.totalRssKiB) {
        firstAtOrBelowBaseline = {
          elapsedMs: Date.now() - teardownStartedAt,
          ...structuredClone(sample),
        };
      }
      globalPeak = mergePeak(globalPeak, sample);
      recordPhasePeak(phasePeaks, 'post-teardown-about-blank', sample);
    }

    const chromeVersion = execFileSync(chromeBinary, ['--version'], { encoding: 'utf8' }).trim();
    const evidence = {
      schemaVersion: '1.1.0',
      kind: 'unzen-endpoint-poststage-webgpu-process-rss-diagnostic',
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
        aggregation: 'sum of Chrome root process and descendants discovered by PPID',
        sampleIntervalMs,
        sampleCount,
        postReportSettleMs,
        postDocumentTeardownSettleMs: postTeardownSettleMs,
        baseline,
        globalPeak,
        phasePeaks: compactPeakMap(phasePeaks),
        afterAllSessionReleaseApisReturned: {
          immediate: immediatePostReport,
          peakDuringSettle: postReportPeak,
          finalAfterSettle: finalPostReport,
        },
        afterDocumentTeardown: {
          action: 'navigate the measured page to about:blank after the release settle window',
          baselineRssKiB: baseline.totalRssKiB,
          immediateAfterBlankReady: immediatePostTeardown,
          peakDuringSettle: postTeardownPeak,
          minimumDuringSettle: postTeardownMinimum,
          firstAtOrBelowBaseline,
          finalAfterSettle: finalPostTeardown,
        },
      },
      runtimeReport,
      conclusion: 'The complete diagnostic post-stage WebGPU run was observed with OS process RSS sampling before, during, and after its nine InferenceSession.release() calls, then through a same-page-target navigation to about:blank. This bounds the sampled Chrome process-tree residency for this run only and separates release-settle behavior from document teardown behavior. It does not measure provider allocations directly or prove GPU/Metal/driver reclamation.',
      limitations: [
        'RSS is an OS process metric, not a WebGPU/Metal allocation metric.',
        'Summing process RSS can double-count shared pages and shared-memory mappings.',
        'On Apple unified memory, RSS cannot distinguish CPU-resident pages from GPU-visible shared allocations.',
        'A decrease after release is observational only; no GC, memory-pressure, or allocator flush was forced.',
        'Navigating to about:blank tears down the measured document context but Chrome may retain renderer processes, reusable allocator pages, driver caches, or shared mappings.',
        'This diagnostic does not select 4-way physical payloads, 8-way execution, or production cache/runtime/dispatcher policy.',
      ],
    };
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    return evidence;
  } finally {
    cdp?.close();
    if (chrome && !chrome.killed) chrome.kill('SIGTERM');
    if (!server.killed) server.kill('SIGTERM');
    await sleep(250);
    rmSync(profileDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  if (argv.length < 2) {
    throw new Error('usage: capture_endpoint_poststage_webgpu_process_rss.mjs DATA_DIR OUTPUT_JSON');
  }
  const dataDir = resolve(argv[0]);
  const outputPath = resolve(argv[1]);
  return {
    dataDir,
    outputPath,
    chromeBinary: process.env.CHROME_BINARY || chromeDefault(),
    serverPort: Number(process.env.UNZEN_HARNESS_PORT ?? 8796),
    debugPort: Number(process.env.UNZEN_CDP_PORT ?? 9336),
    sampleIntervalMs: Number(process.env.UNZEN_RSS_SAMPLE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS),
    postReportSettleMs: Number(process.env.UNZEN_RSS_POST_REPORT_SETTLE_MS ?? DEFAULT_POST_REPORT_SETTLE_MS),
    postTeardownSettleMs: Number(process.env.UNZEN_RSS_POST_TEARDOWN_SETTLE_MS ?? DEFAULT_POST_TEARDOWN_SETTLE_MS),
    timeoutMs: Number(process.env.UNZEN_RSS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const evidence = await runCapture(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
      status: evidence.status,
      baselineRssKiB: evidence.measurement.baseline.totalRssKiB,
      peakRssKiB: evidence.measurement.globalPeak.totalRssKiB,
      finalRssKiB: evidence.measurement.afterAllSessionReleaseApisReturned.finalAfterSettle.totalRssKiB,
      postTeardownFinalRssKiB: evidence.measurement.afterDocumentTeardown.finalAfterSettle.totalRssKiB,
      output: resolve(process.argv[3]),
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
