import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readStableCancellationRssEvidence,
  validateCancellationRssEvidence,
  validateStableFileSnapshotIdentity,
} from '../tools/verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs';

function snapshot(totalRssKiB: number) {
  return {
    processCount: 1,
    totalRssKiB,
    roles: {
      browser: { processCount: 1, rssKiB: totalRssKiB },
    },
  };
}

function validEvidence() {
  const baseline = snapshot(100);
  const globalPeak = snapshot(200);
  const beforeCancellation = snapshot(180);
  const immediateAfterBlankReady = snapshot(160);
  const peakDuringSettle = snapshot(170);
  const minimumDuringSettle = snapshot(90);
  const finalAfterSettle = snapshot(95);
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-endpoint-embedding-eight-physical-webgpu-page-teardown-cancel-rss-diagnostic',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'captured-os-process-rss-after-page-teardown-cancellation',
    capturedAtUtc: '2026-09-10T01:00:00.000Z',
    environment: {
      platform: 'linux',
      osRelease: '6.8.0-test',
      hostTotalMemoryBytes: 16 * 1024 * 1024 * 1024,
      chromeVersion: 'Google Chrome 152.0.8123.45',
      nodeVersion: 'v24.0.0',
      cdpBrowser: 'HeadlessChrome/152.0.8123.45',
    },
    cancellation: {
      targetTile: 3,
      expectedPhase: 'executing embedding tile 3',
      observedPhase: 'executing embedding tile 3',
      reportStatusAtTrigger: null,
      method: 'CDP Page.navigate to about:blank',
      requestToBlankReadyMs: 42,
      boundary: 'coarse page teardown after observing the runner phase; exact ORT progress is not asserted',
    },
    measurement: {
      metric: 'resident-set-size',
      unit: 'KiB',
      aggregation: 'sum of launched Chrome root process and descendants discovered by PPID',
      sampleIntervalMs: 100,
      sampleCount: 12,
      postCancelSettleMs: 30000,
      baseline,
      globalPeak,
      phasePeaks: [
        { phase: 'baseline-about-blank', ...baseline },
        { phase: 'executing embedding tile 3', ...globalPeak },
        { phase: 'post-cancel-about-blank', ...peakDuringSettle },
      ],
      immediatelyBeforeCancellation: beforeCancellation,
      afterDocumentCancellation: {
        action: 'navigate measured page to about:blank as a coarse cancellation boundary',
        baselineRssKiB: baseline.totalRssKiB,
        immediateAfterBlankReady,
        peakDuringSettle,
        minimumDuringSettle,
        firstAtOrBelowBaseline: { elapsedMs: 2500, ...minimumDuringSettle },
        finalAfterSettle,
      },
    },
    conclusion: 'diagnostic-only cancellation RSS evidence',
    limitations: ['RSS is not direct GPU allocator accounting.'],
  };
}

function bigintSnapshot(overrides: Partial<Record<'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs', bigint>> = {}) {
  return {
    dev: 1n,
    ino: 2n,
    size: 100n,
    mtimeNs: 3n,
    ctimeNs: 4n,
    ...overrides,
  };
}

const tempDirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'unzen-cancel-rss-verifier-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('8-physical cancellation RSS evidence validation', () => {
  it('accepts a consistent diagnostic capture envelope', () => {
    const evidence = validEvidence();
    expect(validateCancellationRssEvidence(evidence)).toBe(evidence);
  });

  it.each([
    ['decision status', (e: any) => { e.decisionStatus = 'accepted'; }, /decisionStatus drift/],
    ['observed phase', (e: any) => { e.cancellation.observedPhase = 'executing embedding tile 4'; }, /phase mismatch/],
    ['trigger status', (e: any) => { e.cancellation.reportStatusAtTrigger = 'pass'; }, /must remain null/],
    ['baseline copy', (e: any) => { e.measurement.afterDocumentCancellation.baselineRssKiB = 101; }, /baselineRssKiB mismatch/],
  ])('rejects %s drift', (_label, mutate, pattern) => {
    const evidence = validEvidence();
    mutate(evidence);
    expect(() => validateCancellationRssEvidence(evidence)).toThrow(pattern);
  });

  it('rejects RSS role totals and summary ordering inconsistencies', () => {
    const badRoles = validEvidence();
    badRoles.measurement.baseline.roles.browser.rssKiB = 99;
    expect(() => validateCancellationRssEvidence(badRoles)).toThrow(/does not match role totals/);

    const badGlobal = validEvidence();
    badGlobal.measurement.globalPeak = snapshot(150);
    expect(() => validateCancellationRssEvidence(badGlobal)).toThrow(/globalPeak/);

    const badMinimum = validEvidence();
    badMinimum.measurement.afterDocumentCancellation.minimumDuringSettle = snapshot(165);
    expect(() => validateCancellationRssEvidence(badMinimum)).toThrow(/post-cancel minimum/);
  });

  it('rejects non-canonical time and Chrome/CDP identity drift', () => {
    const badTime = validEvidence();
    badTime.capturedAtUtc = '2026-09-10T01:00:00Z';
    expect(() => validateCancellationRssEvidence(badTime)).toThrow(/canonical UTC/);

    const badChrome = validEvidence();
    badChrome.environment.cdpBrowser = 'HeadlessChrome/153.0.8123.45';
    expect(() => validateCancellationRssEvidence(badChrome)).toThrow(/Chrome\/CDP version mismatch/);
  });

  it('rejects a first-at-or-below-baseline sample that is actually above baseline', () => {
    const evidence = validEvidence();
    evidence.measurement.afterDocumentCancellation.firstAtOrBelowBaseline = {
      elapsedMs: 100,
      ...snapshot(101),
    };
    expect(() => validateCancellationRssEvidence(evidence)).toThrow(/above baseline/);
  });
});

describe('stable cancellation RSS evidence file reading', () => {
  it('reads and validates a bounded regular UTF-8 JSON file', () => {
    const dir = tempDir();
    const path = join(dir, 'evidence.json');
    writeFileSync(path, `${JSON.stringify(validEvidence())}\n`, 'utf8');
    expect(readStableCancellationRssEvidence(path).cancellation.targetTile).toBe(3);
  });

  it('rejects symlinks, oversized input, and invalid UTF-8', () => {
    const dir = tempDir();
    const target = join(dir, 'target.json');
    const link = join(dir, 'link.json');
    writeFileSync(target, `${JSON.stringify(validEvidence())}\n`, 'utf8');
    symlinkSync(target, link);
    expect(() => readStableCancellationRssEvidence(link)).toThrow(/non-symlink regular file/);
    expect(() => readStableCancellationRssEvidence(target, { maxBytes: 32 })).toThrow(/input size/);

    const invalid = join(dir, 'invalid.json');
    writeFileSync(invalid, Buffer.from([0x7b, 0xff, 0x7d]));
    expect(() => readStableCancellationRssEvidence(invalid)).toThrow(/valid UTF-8/);
  });

  it('fails closed when pathname identity or file metadata changes during a read', () => {
    const stable = bigintSnapshot();
    expect(() => validateStableFileSnapshotIdentity(
      stable,
      bigintSnapshot({ ino: 9n }),
      stable,
      stable,
    )).toThrow(/pathname identity changed/);

    expect(() => validateStableFileSnapshotIdentity(
      stable,
      stable,
      bigintSnapshot({ size: 101n }),
      stable,
    )).toThrow(/file changed/);
  });
});
