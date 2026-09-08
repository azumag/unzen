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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function normalizeFootprintMessages(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'object') return [JSON.stringify(value)];
  return [String(value)];
}

function addFootprintCategories(totals, categories) {
  if (!categories || typeof categories !== 'object' || Array.isArray(categories)) return;
  for (const [name, value] of Object.entries(categories)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const current = totals.get(name) ?? {
      dirty: 0,
      swapped: 0,
      clean: 0,
      reclaimable: 0,
      wired: 0,
      regions: 0,
    };
    for (const key of ['dirty', 'swapped', 'clean', 'reclaimable', 'wired', 'regions']) {
      const parsed = Number(value[key] ?? 0);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`footprint JSON category ${JSON.stringify(name)} has invalid ${key}`);
      }
      current[key] += parsed;
    }
    totals.set(name, current);
  }
}

export function summarizeFootprintReport(rootPid, psRows, report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('footprint JSON report must be an object');
  }
  const targetRows = descendantRows(rootPid, psRows);
  const targetRoleByPid = new Map(
    targetRows.map((row) => [row.pid, classifyChromeProcess(row, rootPid)]),
  );
  const errors = normalizeFootprintMessages(report.errors);
  const warnings = normalizeFootprintMessages(report.warnings);
  const processes = Array.isArray(report.processes) ? report.processes : [];
  const processesByPid = new Map();
  for (const proc of processes) {
    const pid = Number(proc?.pid);
    if (!Number.isSafeInteger(pid)) {
      errors.push('footprint JSON contains a process with an invalid pid');
      continue;
    }
    if (processesByPid.has(pid)) {
      errors.push(`footprint JSON contains duplicate process pid ${pid}`);
      continue;
    }
    processesByPid.set(pid, proc);
  }

  const roles = {};
  const categoryTotals = new Map();
  const missingPids = [];
  let measuredProcessCount = 0;
  let totalFootprintBytes = 0;
  for (const row of targetRows) {
    const proc = processesByPid.get(row.pid);
    if (!proc) {
      missingPids.push(row.pid);
      continue;
    }
    const footprintBytes = Number(proc.footprint);
    if (!Number.isSafeInteger(footprintBytes) || footprintBytes < 0) {
      errors.push(`pid ${row.pid}: invalid process footprint`);
      continue;
    }
    measuredProcessCount += 1;
    totalFootprintBytes += footprintBytes;
    const role = targetRoleByPid.get(row.pid);
    const current = roles[role] ?? { processCount: 0, footprintBytes: 0 };
    current.processCount += 1;
    current.footprintBytes += footprintBytes;
    roles[role] = current;
    addFootprintCategories(categoryTotals, proc.categories);
  }

  const missingProcesses = targetRows
    .filter((row) => !processesByPid.has(row.pid))
    .map((row) => ({ pid: row.pid, role: targetRoleByPid.get(row.pid) }));
  const unexpectedPids = [...processesByPid.keys()].filter((pid) => !targetRoleByPid.has(pid));
  if (unexpectedPids.length > 0) {
    errors.push(`footprint JSON contains unexpected pids: ${unexpectedPids.join(',')}`);
  }
  const categoryRows = [...categoryTotals.entries()].map(([name, metrics]) => ({
    name,
    ...metrics,
    dirtyPlusSwappedBytes: metrics.dirty + metrics.swapped,
  }));
  categoryRows.sort((a, b) => b.dirtyPlusSwappedBytes - a.dirtyPlusSwappedBytes || a.name.localeCompare(b.name));
  return {
    targetProcessCount: targetRows.length,
    measuredProcessCount,
    missingProcessCount: missingPids.length,
    missingPids,
    missingProcesses,
    unexpectedPids,
    complete: missingPids.length === 0 && measuredProcessCount === targetRows.length && errors.length === 0,
    totalFootprintBytes,
    roles,
    topCategoriesByDirtyPlusSwappedBytes: categoryRows.slice(0, 12),
    graphicsCategories: categoryRows.filter((entry) => /gpu|graphics|metal|ioaccelerator|iosurface/i.test(entry.name)),
    errors,
    warnings,
  };
}

function currentProcessTree(rootPid) {
  const text = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const psRows = parsePsRows(text);
  return { psRows, targetRows: descendantRows(rootPid, psRows) };
}

function sameProcessIdentitySet(leftRows, rightRows) {
  if (leftRows.length !== rightRows.length) return false;
  const rightByPid = new Map(rightRows.map((row) => [row.pid, row.command]));
  return leftRows.every((row) => rightByPid.get(row.pid) === row.command);
}

function footprintSnapshot(rootPid) {
  if (platform() !== 'darwin') return null;
  let lastError = null;
  let processChurnObserved = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const scratchDir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-poststage-footprint-'));
    const startedAt = Date.now();
    try {
      const before = currentProcessTree(rootPid);
      if (before.targetRows.length === 0) {
        throw new Error('Chrome process tree disappeared before footprint capture');
      }
      const reportPath = join(scratchDir, `footprint-${attempt}.json`);
      const args = ['-j', reportPath];
      for (const row of before.targetRows) args.push('--pid', String(row.pid));
      execFileSync('/usr/bin/footprint', args, {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const after = currentProcessTree(rootPid);
      if (!sameProcessIdentitySet(before.targetRows, after.targetRows)) {
        processChurnObserved = true;
        lastError = new Error('Chrome process identity set changed during footprint capture');
        continue;
      }
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      const summary = summarizeFootprintReport(rootPid, after.psRows, report);
      return {
        captureDurationMs: Date.now() - startedAt,
        collectionMode: 'single-footprint-invocation-multi-pid',
        sweepIsAtomic: false,
        attempts: attempt,
        initialProcessCount: before.targetRows.length,
        finalProcessCount: after.targetRows.length,
        processChurnObserved,
        ...summary,
      };
    } catch (error) {
      lastError = error;
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
    if (attempt < 3) execFileSync('/bin/sleep', ['0.25']);
  }
  throw new Error(`macOS footprint capture failed after 3 attempts: ${lastError}`);
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
    const baselineFootprint = footprintSnapshot(chrome.pid);
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

    const reportObservedAt = Date.now();
    const immediatePostReportFootprint = footprintSnapshot(chrome.pid);
    let postReportPeak = structuredClone(immediatePostReport);
    const settleDeadline = reportObservedAt + postReportSettleMs;
    let finalPostReport = structuredClone(immediatePostReport);
    while (Date.now() < settleDeadline) {
      await sleep(Math.min(sampleIntervalMs, Math.max(0, settleDeadline - Date.now())));
      const sample = psSnapshot(chrome.pid);
      sampleCount += 1;
      finalPostReport = sample;
      postReportPeak = mergePeak(postReportPeak, sample);
      globalPeak = mergePeak(globalPeak, sample);
    }
    const finalPostReportFootprint = footprintSnapshot(chrome.pid);

    await cdp.send('Page.navigate', { url: 'about:blank' });
    await waitForPageUrl(cdp, 'about:blank', 10000);
    const teardownStartedAt = Date.now();
    const immediatePostTeardown = psSnapshot(chrome.pid);
    sampleCount += 1;
    const immediatePostTeardownFootprint = footprintSnapshot(chrome.pid);
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
    const finalPostTeardownFootprint = footprintSnapshot(chrome.pid);

    const chromeVersion = execFileSync(chromeBinary, ['--version'], { encoding: 'utf8' }).trim();
    const footprintMilestones = [
      baselineFootprint,
      immediatePostReportFootprint,
      finalPostReportFootprint,
      immediatePostTeardownFootprint,
      finalPostTeardownFootprint,
    ].filter(Boolean);
    const completeFootprintMilestoneCount = footprintMilestones.filter((snapshot) => snapshot.complete).length;
    const allFootprintMilestonesComplete = footprintMilestones.length > 0
      && completeFootprintMilestoneCount === footprintMilestones.length;
    const footprintEvidenceLevel = baselineFootprint
      ? (allFootprintMilestonesComplete
        ? 'captured-os-process-rss+macos-physical-footprint'
        : 'captured-os-process-rss+partial-macos-physical-footprint')
      : 'captured-os-process-rss';
    const evidence = {
      schemaVersion: '1.2.0',
      kind: 'unzen-endpoint-poststage-webgpu-process-rss-diagnostic',
      status: 'pass',
      decisionStatus: 'diagnostic-only',
      evidenceLevel: footprintEvidenceLevel,
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
        macosPhysicalFootprint: baselineFootprint ? {
          metric: 'macOS physical footprint reported by /usr/bin/footprint',
          unit: 'bytes',
          aggregation: 'one /usr/bin/footprint invocation with repeated --pid arguments for the Chrome root and descendants from one ps identity set; the snapshot is marked incomplete if footprint omits any stable target pid',
          milestoneCount: footprintMilestones.length,
          completeMilestoneCount: completeFootprintMilestoneCount,
          completeAcrossMilestones: allFootprintMilestonesComplete,
          baseline: baselineFootprint,
          afterAllSessionReleaseApisReturned: {
            immediate: immediatePostReportFootprint,
            finalAfterSettle: finalPostReportFootprint,
          },
          afterDocumentTeardown: {
            immediateAfterBlankReady: immediatePostTeardownFootprint,
            finalAfterSettle: finalPostTeardownFootprint,
          },
        } : null,
      },
      runtimeReport,
      conclusion: 'The complete diagnostic post-stage WebGPU run was observed with OS process RSS sampling before, during, and after its nine InferenceSession.release() calls, then through a same-page-target navigation to about:blank. On macOS, milestone snapshots additionally capture kernel physical-footprint accounting and per-process-role/category attribution. These metrics bound this isolated run only; neither directly measures ORT/WebGPU/Metal allocations or proves provider/driver reclamation.',
      limitations: [
        'RSS and macOS physical footprint are OS process metrics, not ORT/WebGPU/Metal allocation metrics.',
        'The macOS footprint command is sampled only at milestones, so it does not identify the physical-footprint peak during tile execution and its inspection can perturb process timing.',
        'macOS footprint can omit a stable sandboxed Chrome child without an error; each milestone records completeness and missing process roles, and partial snapshots are not promoted to whole-tree footprint evidence.',
        'Footprint category names such as IOAccelerator, IOSurface, or graphics are kernel VM accounting labels and must not be interpreted as exact live WebGPU allocation sizes.',
        'Category ranking uses dirty + swapped bytes; wired bytes are reported separately and are not added because wired accounting can overlap dirty pages.',
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
