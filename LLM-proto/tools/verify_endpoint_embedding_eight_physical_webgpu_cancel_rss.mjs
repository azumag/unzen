#!/usr/bin/env node
/** Read-only verifier for captured 8-physical page-teardown cancellation RSS evidence. */
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

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const EXPECTED = Object.freeze({
  schemaVersion: '1.0.0',
  kind: 'unzen-endpoint-embedding-eight-physical-webgpu-page-teardown-cancel-rss-diagnostic',
  status: 'pass',
  decisionStatus: 'diagnostic-only',
  evidenceLevel: 'captured-os-process-rss-after-page-teardown-cancellation',
  metric: 'resident-set-size',
  unit: 'KiB',
  aggregation: 'sum of launched Chrome root process and descendants discovered by PPID',
  cancellationMethod: 'CDP Page.navigate to about:blank',
  postCancelAction: 'navigate measured page to about:blank as a coarse cancellation boundary',
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

export function validateRssSnapshot(snapshot, label = 'RSS snapshot') {
  requireObject(snapshot, label);
  const processCount = requireSafeInteger(snapshot.processCount, `${label}.processCount`, 1);
  const totalRssKiB = requireSafeInteger(snapshot.totalRssKiB, `${label}.totalRssKiB`, 0);
  const roles = requireObject(snapshot.roles, `${label}.roles`);
  const entries = Object.entries(roles);
  if (entries.length === 0) throw new Error(`${label}.roles must not be empty`);
  let roleProcessCount = 0;
  let roleRssKiB = 0;
  for (const [role, summary] of entries) {
    requireString(role, `${label}.roles key`);
    requireObject(summary, `${label}.roles.${role}`);
    roleProcessCount += requireSafeInteger(summary.processCount, `${label}.roles.${role}.processCount`, 1);
    roleRssKiB += requireSafeInteger(summary.rssKiB, `${label}.roles.${role}.rssKiB`, 0);
  }
  if (roleProcessCount !== processCount) throw new Error(`${label} processCount does not match role totals`);
  if (roleRssKiB !== totalRssKiB) throw new Error(`${label} totalRssKiB does not match role totals`);
  return snapshot;
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
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateCancellationRssEvidence(evidence) {
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

  const cancellation = requireObject(evidence.cancellation, 'cancellation');
  const targetTile = requireSafeInteger(cancellation.targetTile, 'cancellation.targetTile', 0);
  if (targetTile > 7) throw new Error('cancellation.targetTile must be in 0..7');
  const expectedPhase = `executing embedding tile ${targetTile}`;
  if (cancellation.expectedPhase !== expectedPhase || cancellation.observedPhase !== expectedPhase) {
    throw new Error('cancellation phase mismatch');
  }
  if (cancellation.reportStatusAtTrigger !== null) {
    throw new Error('cancellation.reportStatusAtTrigger must remain null');
  }
  if (cancellation.method !== EXPECTED.cancellationMethod) throw new Error('cancellation method drift');
  requireSafeInteger(cancellation.requestToBlankReadyMs, 'cancellation.requestToBlankReadyMs', 0);
  requireString(cancellation.boundary, 'cancellation.boundary');

  const measurement = requireObject(evidence.measurement, 'measurement');
  if (measurement.metric !== EXPECTED.metric) throw new Error('measurement.metric drift');
  if (measurement.unit !== EXPECTED.unit) throw new Error('measurement.unit drift');
  if (measurement.aggregation !== EXPECTED.aggregation) throw new Error('measurement.aggregation drift');
  requireSafeInteger(measurement.sampleIntervalMs, 'measurement.sampleIntervalMs', 1);
  requireSafeInteger(measurement.sampleCount, 'measurement.sampleCount', 3);
  requireSafeInteger(measurement.postCancelSettleMs, 'measurement.postCancelSettleMs', 0);

  const baseline = validateRssSnapshot(measurement.baseline, 'measurement.baseline');
  const globalPeak = validateRssSnapshot(measurement.globalPeak, 'measurement.globalPeak');
  const beforeCancel = validateRssSnapshot(
    measurement.immediatelyBeforeCancellation,
    'measurement.immediatelyBeforeCancellation',
  );
  assertAtLeast(globalPeak, baseline, 'globalPeak/baseline');
  assertAtLeast(globalPeak, beforeCancel, 'globalPeak/immediatelyBeforeCancellation');

  if (!Array.isArray(measurement.phasePeaks) || measurement.phasePeaks.length < 2) {
    throw new Error('measurement.phasePeaks must contain at least baseline and post-cancel phases');
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

  const after = requireObject(measurement.afterDocumentCancellation, 'measurement.afterDocumentCancellation');
  if (after.action !== EXPECTED.postCancelAction) throw new Error('post-cancel action drift');
  if (after.baselineRssKiB !== baseline.totalRssKiB) throw new Error('post-cancel baselineRssKiB mismatch');
  const immediate = validateRssSnapshot(after.immediateAfterBlankReady, 'afterDocumentCancellation.immediateAfterBlankReady');
  const peak = validateRssSnapshot(after.peakDuringSettle, 'afterDocumentCancellation.peakDuringSettle');
  const minimum = validateRssSnapshot(after.minimumDuringSettle, 'afterDocumentCancellation.minimumDuringSettle');
  const final = validateRssSnapshot(after.finalAfterSettle, 'afterDocumentCancellation.finalAfterSettle');
  for (const snapshot of [immediate, peak, minimum, final]) assertAtLeast(globalPeak, snapshot, 'globalPeak/post-cancel');
  for (const snapshot of [immediate, minimum, final]) assertAtLeast(peak, snapshot, 'post-cancel peak');
  for (const snapshot of [immediate, peak, final]) assertAtMost(minimum, snapshot, 'post-cancel minimum');

  const postCancelPhasePeak = phases.get('post-cancel-about-blank');
  if (!postCancelPhasePeak || !exactSnapshot(postCancelPhasePeak, peak)) {
    throw new Error('post-cancel phase peak does not match settle peak');
  }

  if (after.firstAtOrBelowBaseline !== null) {
    const first = requireObject(after.firstAtOrBelowBaseline, 'afterDocumentCancellation.firstAtOrBelowBaseline');
    requireSafeInteger(first.elapsedMs, 'afterDocumentCancellation.firstAtOrBelowBaseline.elapsedMs', 0);
    const { elapsedMs: ignored, ...snapshot } = first;
    validateRssSnapshot(snapshot, 'afterDocumentCancellation.firstAtOrBelowBaseline snapshot');
    if (snapshot.totalRssKiB > baseline.totalRssKiB) {
      throw new Error('firstAtOrBelowBaseline is above baseline');
    }
    assertAtLeast(peak, snapshot, 'post-cancel peak/firstAtOrBelowBaseline');
    assertAtMost(minimum, snapshot, 'post-cancel minimum/firstAtOrBelowBaseline');
  }

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

export function validateStableFileSnapshotIdentity(beforePath, beforeFd, afterFd, afterPath) {
  const snapshots = { beforePath, beforeFd, afterFd, afterPath };
  for (const [label, snapshot] of Object.entries(snapshots)) {
    requireObject(snapshot, label);
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
      if (typeof snapshot[field] !== 'bigint') throw new Error(`${label}.${field} must be bigint`);
    }
  }
  for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    const expected = beforePath[field];
    if (beforeFd[field] !== expected || afterFd[field] !== expected || afterPath[field] !== expected) {
      if (field === 'dev' || field === 'ino') throw new Error('evidence pathname identity changed during read');
      throw new Error('evidence file changed during read');
    }
  }
}

function parseMaxBytes(value) {
  const parsed = Number(value ?? DEFAULT_MAX_BYTES);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 256 * 1024 * 1024) {
    throw new Error('UNZEN_CANCEL_RSS_EVIDENCE_MAX_BYTES must be an integer in 1..268435456');
  }
  return parsed;
}

export function readStableCancellationRssEvidence(path, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
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
    return validateCancellationRssEvidence(evidence);
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) {
      throw new Error('usage: verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs EVIDENCE_JSON');
    }
    const evidence = readStableCancellationRssEvidence(process.argv[2], {
      maxBytes: parseMaxBytes(process.env.UNZEN_CANCEL_RSS_EVIDENCE_MAX_BYTES),
    });
    console.log(JSON.stringify({
      status: 'pass',
      evidence: resolve(process.argv[2]),
      targetTile: evidence.cancellation.targetTile,
      baselineRssKiB: evidence.measurement.baseline.totalRssKiB,
      peakRssKiB: evidence.measurement.globalPeak.totalRssKiB,
      postCancelMinimumRssKiB: evidence.measurement.afterDocumentCancellation.minimumDuringSettle.totalRssKiB,
      firstAtOrBelowBaselineObserved: evidence.measurement.afterDocumentCancellation.firstAtOrBelowBaseline !== null,
      decisionStatus: evidence.decisionStatus,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
