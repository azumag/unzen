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
  readStableProcessRssEvidence,
  validateProcessRssEvidence,
} from '../tools/verify_endpoint_embedding_eight_physical_webgpu_process_rss.mjs';

function snapshot(totalRssKiB: number) {
  return {
    processCount: 1,
    totalRssKiB,
    roles: {
      browser: { processCount: 1, rssKiB: totalRssKiB },
    },
  };
}

function runtimeReport() {
  const verifiedPhysicalArtifacts = Array.from({ length: 8 }, (_, index) => ({
    index,
    file: `payload-${String(index).padStart(4, '0')}.bin`,
    bytes: 131_334_144,
    sha256: index.toString(16).repeat(64).slice(0, 64),
  }));
  const executedTiles = verifiedPhysicalArtifacts.map((artifact, index) => ({
    tileIndex: index,
    physicalArtifactIndex: index,
    payloadFile: artifact.file,
    payloadSha256: artifact.sha256,
    artifactByteOffset: 0,
    byteLength: 131_334_144,
    comparison: {
      exactEqual: true,
      firstByteMismatch: -1,
      maxAbsDiff: 0,
      worstIndex: -1,
    },
    sessionCreateMs: 10 + index,
    runMs: 2 + index,
    sessionReleaseMs: 1 + index,
  }));
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-embedding-eight-physical-ort-webgpu-runtime',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    evidenceLevel: 'self-reported-runtime',
    onnxruntimeWebVersion: '1.22.0',
    manifestPayloadSetSha256: 'a'.repeat(64),
    verifiedGraph: {
      file: 'embedding-offset-0.onnx',
      bytes: 260,
      sha256: 'b'.repeat(64),
    },
    verifiedPhysicalArtifacts,
    executedTiles,
    completeEmbeddingComparison: {
      exactEqual: true,
      firstByteMismatch: -1,
      maxAbsDiff: 0,
      worstIndex: -1,
    },
    outputShape: [16, 2048],
    sequentialExecution: {
      tilesPerPhysicalArtifact: 1,
    },
    sessionReleaseApiCompleted: true,
  };
}

function validEvidence() {
  const baseline = snapshot(100);
  const globalPeak = snapshot(250);
  const releaseImmediate = snapshot(210);
  const releasePeak = snapshot(230);
  const releaseFinal = snapshot(200);
  const teardownImmediate = snapshot(150);
  const teardownPeak = snapshot(160);
  const teardownMinimum = snapshot(90);
  const teardownFinal = snapshot(95);
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-endpoint-embedding-eight-physical-webgpu-process-rss-diagnostic',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'captured-os-process-rss',
    capturedAtUtc: '2026-09-10T03:00:00.000Z',
    environment: {
      platform: 'linux',
      osRelease: '6.8.0-test',
      hostTotalMemoryBytes: 16 * 1024 * 1024 * 1024,
      chromeVersion: 'Google Chrome 152.0.8123.45',
      nodeVersion: 'v24.0.0',
      cdpBrowser: 'HeadlessChrome/152.0.8123.45',
    },
    measurement: {
      metric: 'resident-set-size',
      unit: 'KiB',
      aggregation: 'sum of launched Chrome root process and descendants discovered by PPID',
      sampleIntervalMs: 100,
      sampleCount: 20,
      postReportSettleMs: 5000,
      postDocumentTeardownSettleMs: 30000,
      baseline,
      globalPeak,
      phasePeaks: [
        { phase: 'baseline-about-blank', ...baseline },
        { phase: 'executing embedding tile 4', ...snapshot(220) },
        { phase: 'post-report-release-settle', ...releasePeak },
        { phase: 'post-teardown-about-blank', ...teardownPeak },
      ],
      afterAllSessionReleaseApisReturned: {
        immediate: releaseImmediate,
        peakDuringSettle: releasePeak,
        finalAfterSettle: releaseFinal,
      },
      afterDocumentTeardown: {
        action: 'navigate measured page to about:blank after the release settle window',
        baselineRssKiB: baseline.totalRssKiB,
        immediateAfterBlankReady: teardownImmediate,
        peakDuringSettle: teardownPeak,
        minimumDuringSettle: teardownMinimum,
        firstAtOrBelowBaseline: { elapsedMs: 2500, ...teardownMinimum },
        finalAfterSettle: teardownFinal,
      },
    },
    runtimeReport: runtimeReport(),
    conclusion: 'diagnostic-only normal-completion RSS evidence',
    limitations: ['RSS is not direct GPU allocator accounting.'],
  };
}

const tempDirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'unzen-process-rss-verifier-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  delete process.env.UNZEN_PROCESS_RSS_EVIDENCE_MAX_BYTES;
});

describe('8-physical normal-completion process RSS evidence validation', () => {
  it('accepts a consistent captured envelope and embedded runtime report', () => {
    const evidence = validEvidence();
    expect(validateProcessRssEvidence(evidence)).toBe(evidence);
  });

  it.each([
    ['decision status', (e: any) => { e.decisionStatus = 'selected'; }, /decisionStatus drift/],
    ['evidence level', (e: any) => { e.evidenceLevel = 'self-reported-runtime'; }, /evidenceLevel drift/],
    ['Chrome identity', (e: any) => { e.environment.cdpBrowser = 'HeadlessChrome/153.0.8123.45'; }, /Chrome\/CDP version mismatch/],
    ['runtime report', (e: any) => { e.runtimeReport.sessionReleaseApiCompleted = false; }, /sessionReleaseApiCompleted/],
    ['teardown baseline copy', (e: any) => { e.measurement.afterDocumentTeardown.baselineRssKiB = 101; }, /baselineRssKiB mismatch/],
  ])('rejects %s drift', (_label, mutate, pattern) => {
    const evidence = validEvidence();
    mutate(evidence);
    expect(() => validateProcessRssEvidence(evidence)).toThrow(pattern);
  });

  it('rejects RSS role totals and impossible peak/minimum relationships', () => {
    const badRoles = validEvidence();
    badRoles.measurement.baseline.roles.browser.rssKiB = 99;
    expect(() => validateProcessRssEvidence(badRoles)).toThrow(/does not match role totals/);

    const badReleasePeak = validEvidence();
    badReleasePeak.measurement.afterAllSessionReleaseApisReturned.peakDuringSettle = snapshot(205);
    expect(() => validateProcessRssEvidence(badReleasePeak)).toThrow(/post-release peak/);

    const badTeardownMinimum = validEvidence();
    badTeardownMinimum.measurement.afterDocumentTeardown.minimumDuringSettle = snapshot(155);
    expect(() => validateProcessRssEvidence(badTeardownMinimum)).toThrow(/post-teardown minimum/);
  });

  it('pins release peak to max(immediate, settle-phase peak) using capture tie semantics', () => {
    const immediateWins = validEvidence();
    immediateWins.measurement.afterAllSessionReleaseApisReturned.immediate = snapshot(240);
    immediateWins.measurement.afterAllSessionReleaseApisReturned.peakDuringSettle = snapshot(240);
    expect(validateProcessRssEvidence(immediateWins)).toBe(immediateWins);

    const wrongWinner = validEvidence();
    wrongWinner.measurement.afterAllSessionReleaseApisReturned.immediate = snapshot(240);
    wrongWinner.measurement.afterAllSessionReleaseApisReturned.peakDuringSettle = snapshot(230);
    expect(() => validateProcessRssEvidence(wrongWinner)).toThrow(/post-release peak/);
  });

  it('requires persisted phase peaks to match captured settle semantics', () => {
    const badReleasePhase = validEvidence();
    const entry = badReleasePhase.measurement.phasePeaks.find((item) => item.phase === 'post-report-release-settle')!;
    Object.assign(entry, snapshot(229));
    expect(() => validateProcessRssEvidence(badReleasePhase)).toThrow(/post-release peak/);

    const badTeardownPhase = validEvidence();
    const teardownEntry = badTeardownPhase.measurement.phasePeaks.find((item) => item.phase === 'post-teardown-about-blank')!;
    Object.assign(teardownEntry, snapshot(159));
    expect(() => validateProcessRssEvidence(badTeardownPhase)).toThrow(/post-teardown phase peak/);
  });

  it('accepts a zero-length post-release settle only without a synthetic settle phase', () => {
    const evidence = validEvidence();
    evidence.measurement.postReportSettleMs = 0;
    evidence.measurement.phasePeaks = evidence.measurement.phasePeaks.filter(
      (entry) => entry.phase !== 'post-report-release-settle',
    );
    evidence.measurement.afterAllSessionReleaseApisReturned.peakDuringSettle =
      evidence.measurement.afterAllSessionReleaseApisReturned.immediate;
    evidence.measurement.afterAllSessionReleaseApisReturned.finalAfterSettle =
      evidence.measurement.afterAllSessionReleaseApisReturned.immediate;
    expect(validateProcessRssEvidence(evidence)).toBe(evidence);

    evidence.measurement.phasePeaks.push({
      phase: 'post-report-release-settle',
      ...evidence.measurement.afterAllSessionReleaseApisReturned.immediate,
    });
    expect(() => validateProcessRssEvidence(evidence)).toThrow(/zero-length post-release settle/);
  });

  it('rejects a first-at-or-below-baseline sample that is actually above baseline', () => {
    const evidence = validEvidence();
    evidence.measurement.afterDocumentTeardown.firstAtOrBelowBaseline = {
      elapsedMs: 100,
      ...snapshot(101),
    };
    expect(() => validateProcessRssEvidence(evidence)).toThrow(/above baseline/);
  });
});

describe('stable normal-completion process RSS evidence file reading', () => {
  it('reads and validates a bounded regular UTF-8 JSON file', () => {
    const dir = tempDir();
    const path = join(dir, 'evidence.json');
    writeFileSync(path, `${JSON.stringify(validEvidence())}\n`, 'utf8');
    expect(readStableProcessRssEvidence(path).runtimeReport.sessionReleaseApiCompleted).toBe(true);
  });

  it('honors the configured environment size bound', () => {
    const dir = tempDir();
    const path = join(dir, 'evidence.json');
    writeFileSync(path, `${JSON.stringify(validEvidence())}\n`, 'utf8');
    process.env.UNZEN_PROCESS_RSS_EVIDENCE_MAX_BYTES = '32';
    expect(() => readStableProcessRssEvidence(path)).toThrow(/input size/);
  });

  it('rejects symlinks, oversized input, and invalid UTF-8', () => {
    const dir = tempDir();
    const target = join(dir, 'target.json');
    const link = join(dir, 'link.json');
    writeFileSync(target, `${JSON.stringify(validEvidence())}\n`, 'utf8');
    symlinkSync(target, link);
    expect(() => readStableProcessRssEvidence(link)).toThrow(/non-symlink regular file/);
    expect(() => readStableProcessRssEvidence(target, { maxBytes: 32 })).toThrow(/input size/);

    const invalid = join(dir, 'invalid.json');
    writeFileSync(invalid, Buffer.from([0x7b, 0xff, 0x7d]));
    expect(() => readStableProcessRssEvidence(invalid)).toThrow(/valid UTF-8/);
  });
});
