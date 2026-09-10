#!/usr/bin/env node
/** Read-only verifier for captured 8-physical normal-completion process-RSS evidence. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEightPhysicalRuntimeReport } from './capture_endpoint_embedding_eight_physical_webgpu_process_rss.mjs';
import {
  validateRssSnapshot,
  validateStableFileSnapshotIdentity,
} from './verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const EXPECTED = Object.freeze({
  schemaVersion: '1.0.0',
  kind: 'unzen-endpoint-embedding-eight-physical-webgpu-process-rss-diagnostic',
  status: 'pass',
  decisionStatus: 'diagnostic-only',
  evidenceLevel: 'captured-os-process-rss',
  metric: 'resident-set-size',
  unit: 'KiB',
  aggregation: 'sum of launched Chrome root process and descendants discovered by PPID',
  teardownAction: 'navigate measured page to about:blank after the release settle window',
});

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function requireCanonicalUtc(value, label) {
  requireString(value, label);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
  return value;
}

function parseChromeVersion(raw, label) {
  const match = requireString(raw, label).match(/(\d+\.\d+\.\d+\.\d+)/);
  if (!match) throw new Error(`${label} must contain a four-part Chrome version`);
  return match[1];
}

function parseCdpChromeVersion(raw) {
  const match = requireString(raw, 'environment.cdpBrowser')
    .match(/^(?:HeadlessChrome|Chrome)\/(\d+\.\d+\.\d+\.\d+)\b/);
  if (!match) throw new Error('environment.cdpBrowser must identify Chrome/HeadlessChrome');
  return match[1];
}

function assertAtLeast(left, right, label) {
  if (left.totalRssKiB < right.totalRssKiB) {
    throw new Error(`${label} RSS ordering is inconsistent`);
  }
}

function assertAtMost(left, right, label) {
  if (left.totalRssKiB > right.totalRssKiB) {
    throw new Error(`${label} RSS ordering is inconsistent`);
  }
}

function exactSnapshot(left, right) {
  if (left.processCount !== right.processCount || left.totalRssKiB !== right.totalRssKiB) return false;
  const leftRoles = Object.keys(left.roles).sort();
  const rightRoles = Object.keys(right.roles).sort();
  if (leftRoles.length !== rightRoles.length || leftRoles.some((role, index) => role !== rightRoles[index])) return false;
  return leftRoles.every((role) => (
    left.roles[role].processCount === right.roles[role].processCount
    && left.roles[role].rssKiB === right.roles[role].rssKiB
  ));
}

export function validateProcessRssEvidence(evidence) {
  requireObject(evidence, 'evidence');
  for (const field of ['schemaVersion', 'kind', 'status', 'decisionStatus', 'evidenceLevel']) {
    if (evidence[field] !== EXPECTED[field]) throw new Error(`${field} drift`);
  }
  requireCanonicalUtc(evidence.capturedAtUtc, 'capturedAtUtc');

  const environment = requireObject(evidence.environment, 'environment');
  if (!['darwin', 'linux'].includes(environment.platform)) throw new Error('environment.platform drift');
  requireString(environment.osRelease, 'environment.osRelease');
  requireSafeInteger(environment.hostTotalMemoryBytes, 'environment.hostTotalMemoryBytes', 1);
  if (!/^v\d+\.\d+\.\d+/.test(requireString(environment.nodeVersion, 'environment.nodeVersion'))) {
    throw new Error('environment.nodeVersion format drift');
  }
  const chromeVersion = parseChromeVersion(environment.chromeVersion, 'environment.chromeVersion');
  const cdpVersion = parseCdpChromeVersion(environment.cdpBrowser);
  if (chromeVersion !== cdpVersion) throw new Error('environment Chrome/CDP version mismatch');

  const measurement = requireObject(evidence.measurement, 'measurement');
  if (measurement.metric !== EXPECTED.metric) throw new Error('measurement.metric drift');
  if (measurement.unit !== EXPECTED.unit) throw new Error('measurement.unit drift');
  if (measurement.aggregation !== EXPECTED.aggregation) throw new Error('measurement.aggregation drift');
  requireSafeInteger(measurement.sampleIntervalMs, 'measurement.sampleIntervalMs', 1);
  requireSafeInteger(measurement.sampleCount, 'measurement.sampleCount', 3);
  requireSafeInteger(measurement.postReportSettleMs, 'measurement.postReportSettleMs', 0);
  requireSafeInteger(
    measurement.postDocumentTeardownSettleMs,
    'measurement.postDocumentTeardownSettleMs',
    0,
  );

  const baseline = validateRssSnapshot(measurement.baseline, 'measurement.baseline');
  const globalPeak = validateRssSnapshot(measurement.globalPeak, 'measurement.globalPeak');
  assertAtLeast(globalPeak, baseline, 'globalPeak/baseline');

  if (!Array.isArray(measurement.phasePeaks) || measurement.phasePeaks.length < 2) {
    throw new Error('measurement.phasePeaks must contain at least baseline and post-teardown phases');
  }
  const phases = new Map();
  for (const entry of measurement.phasePeaks) {
    requireObject(entry, 'measurement.phasePeaks entry');
    const phase = requireString(entry.phase, 'measurement.phasePeaks[].phase');
    if (phases.has(phase)) throw new Error(`duplicate phase peak ${phase}`);
    const { phase: ignored, ...snapshot } = entry;
    validateRssSnapshot(snapshot, `measurement.phasePeaks[${phase}]`);
    phases.set(phase, snapshot);
    assertAtLeast(globalPeak, snapshot, `globalPeak/phase ${phase}`);
  }
  if (!phases.has('baseline-about-blank') || !exactSnapshot(phases.get('baseline-about-blank'), baseline)) {
    throw new Error('baseline phase peak does not match baseline snapshot');
  }

  const afterRelease = requireObject(
    measurement.afterAllSessionReleaseApisReturned,
    'measurement.afterAllSessionReleaseApisReturned',
  );
  const releaseImmediate = validateRssSnapshot(afterRelease.immediate, 'afterAllSessionReleaseApisReturned.immediate');
  const releasePeak = validateRssSnapshot(afterRelease.peakDuringSettle, 'afterAllSessionReleaseApisReturned.peakDuringSettle');
  const releaseFinal = validateRssSnapshot(afterRelease.finalAfterSettle, 'afterAllSessionReleaseApisReturned.finalAfterSettle');
  for (const snapshot of [releaseImmediate, releasePeak, releaseFinal]) {
    assertAtLeast(globalPeak, snapshot, 'globalPeak/post-release');
  }
  for (const snapshot of [releaseImmediate, releaseFinal]) {
    assertAtLeast(releasePeak, snapshot, 'post-release peak');
  }
  const releasePhasePeak = phases.get('post-report-release-settle');
  if (measurement.postReportSettleMs === 0) {
    if (releasePhasePeak) throw new Error('zero-length post-release settle must not contain a settle phase peak');
  } else if (!releasePhasePeak || !exactSnapshot(releasePhasePeak, releasePeak)) {
    throw new Error('post-release phase peak does not match settle peak');
  }

  const afterTeardown = requireObject(measurement.afterDocumentTeardown, 'measurement.afterDocumentTeardown');
  if (afterTeardown.action !== EXPECTED.teardownAction) throw new Error('document teardown action drift');
  if (afterTeardown.baselineRssKiB !== baseline.totalRssKiB) throw new Error('document teardown baselineRssKiB mismatch');
  const teardownImmediate = validateRssSnapshot(afterTeardown.immediateAfterBlankReady, 'afterDocumentTeardown.immediateAfterBlankReady');
  const teardownPeak = validateRssSnapshot(afterTeardown.peakDuringSettle, 'afterDocumentTeardown.peakDuringSettle');
  const teardownMinimum = validateRssSnapshot(afterTeardown.minimumDuringSettle, 'afterDocumentTeardown.minimumDuringSettle');
  const teardownFinal = validateRssSnapshot(afterTeardown.finalAfterSettle, 'afterDocumentTeardown.finalAfterSettle');
  for (const snapshot of [teardownImmediate, teardownPeak, teardownMinimum, teardownFinal]) {
    assertAtLeast(globalPeak, snapshot, 'globalPeak/post-teardown');
  }
  for (const snapshot of [teardownImmediate, teardownMinimum, teardownFinal]) {
    assertAtLeast(teardownPeak, snapshot, 'post-teardown peak');
  }
  for (const snapshot of [teardownImmediate, teardownPeak, teardownFinal]) {
    assertAtMost(teardownMinimum, snapshot, 'post-teardown minimum');
  }
  const teardownPhasePeak = phases.get('post-teardown-about-blank');
  if (!teardownPhasePeak || !exactSnapshot(teardownPhasePeak, teardownPeak)) {
    throw new Error('post-teardown phase peak does not match settle peak');
  }

  if (afterTeardown.firstAtOrBelowBaseline !== null) {
    const first = requireObject(afterTeardown.firstAtOrBelowBaseline, 'afterDocumentTeardown.firstAtOrBelowBaseline');
    requireSafeInteger(first.elapsedMs, 'afterDocumentTeardown.firstAtOrBelowBaseline.elapsedMs', 0);
    const { elapsedMs: ignored, ...snapshot } = first;
    validateRssSnapshot(snapshot, 'afterDocumentTeardown.firstAtOrBelowBaseline snapshot');
    if (snapshot.totalRssKiB > baseline.totalRssKiB) {
      throw new Error('firstAtOrBelowBaseline is above baseline');
    }
    assertAtLeast(teardownPeak, snapshot, 'post-teardown peak/firstAtOrBelowBaseline');
    assertAtMost(teardownMinimum, snapshot, 'post-teardown minimum/firstAtOrBelowBaseline');
  }

  validateEightPhysicalRuntimeReport(evidence.runtimeReport);
  requireString(evidence.conclusion, 'conclusion');
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length === 0) {
    throw new Error('limitations must be a non-empty array');
  }
  evidence.limitations.forEach((entry, index) => requireString(entry, `limitations[${index}]`));
  return evidence;
}

function fileSnapshot(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function parseMaxBytes(value) {
  const parsed = Number(value ?? DEFAULT_MAX_BYTES);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 256 * 1024 * 1024) {
    throw new Error('UNZEN_PROCESS_RSS_EVIDENCE_MAX_BYTES must be an integer in 1..268435456');
  }
  return parsed;
}

export function readStableProcessRssEvidence(path, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const resolved = resolve(path);
  const boundedMax = parseMaxBytes(maxBytes);
  const beforePathStat = lstatSync(resolved, { bigint: true });
  if (!beforePathStat.isFile() || beforePathStat.isSymbolicLink()) {
    throw new Error('evidence input must be a non-symlink regular file');
  }
  if (beforePathStat.size < 1n || beforePathStat.size > BigInt(boundedMax)) {
    throw new Error(`evidence input size must be 1..${boundedMax} bytes`);
  }

  const fd = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const beforeFdStat = fstatSync(fd, { bigint: true });
    if (!beforeFdStat.isFile()) throw new Error('evidence input descriptor is not a regular file');
    const initialSize = Number(beforeFdStat.size);
    if (initialSize < 1 || initialSize > boundedMax) throw new Error(`evidence input size must be 1..${boundedMax} bytes`);
    const chunks = [];
    let total = 0;
    while (total <= initialSize) {
      const remaining = initialSize + 1 - total;
      if (remaining <= 0) break;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    if (total !== initialSize) throw new Error('evidence file size changed while reading');

    const afterFdStat = fstatSync(fd, { bigint: true });
    const afterPathStat = lstatSync(resolved, { bigint: true });
    validateStableFileSnapshotIdentity(
      fileSnapshot(beforePathStat),
      fileSnapshot(beforeFdStat),
      fileSnapshot(afterFdStat),
      fileSnapshot(afterPathStat),
    );

    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new Error('evidence input is not valid UTF-8');
    }
    let evidence;
    try {
      evidence = JSON.parse(text);
    } catch (error) {
      throw new Error(`evidence input is not valid JSON: ${error instanceof Error ? error.message : error}`);
    }
    return validateProcessRssEvidence(evidence);
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) {
      throw new Error('usage: verify_endpoint_embedding_eight_physical_webgpu_process_rss.mjs PROCESS_RSS_JSON');
    }
    const evidence = readStableProcessRssEvidence(process.argv[2]);
    console.log(JSON.stringify({
      status: evidence.status,
      decisionStatus: evidence.decisionStatus,
      evidenceLevel: evidence.evidenceLevel,
      capturedAtUtc: evidence.capturedAtUtc,
      baselineRssKiB: evidence.measurement.baseline.totalRssKiB,
      peakRssKiB: evidence.measurement.globalPeak.totalRssKiB,
      postReleaseFinalRssKiB: evidence.measurement.afterAllSessionReleaseApisReturned.finalAfterSettle.totalRssKiB,
      postTeardownFinalRssKiB: evidence.measurement.afterDocumentTeardown.finalAfterSettle.totalRssKiB,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
