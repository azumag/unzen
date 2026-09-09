import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyChromeProcess,
  descendantRows,
  mergeMinimum,
  mergePeak,
  parseCaptureArgs,
  parsePsRows,
  summarizeProcessRows,
  summarizeFootprintReport,
} from '../tools/capture_endpoint_poststage_webgpu_process_rss.mjs';

describe('endpoint post-stage WebGPU process RSS diagnostic helpers', () => {
  const snapshot = `
   10     1 100000 /Applications/Google Chrome --headless=new
   11    10  50000 /Applications/Google Chrome Helper --type=gpu-process --foo
   12    10  60000 /Applications/Google Chrome Helper --type=renderer --bar
   13    10  20000 /Applications/Google Chrome Helper --type=utility --utility-sub-type=network.mojom.NetworkService
   14    12  10000 /Applications/Google Chrome Helper --type=utility --utility-sub-type=storage.mojom.StorageService
   99     1 999999 unrelated
  `;

  it('parses ps rows and follows only descendants of the launched Chrome root', () => {
    const rows = parsePsRows(snapshot);
    expect(rows).toHaveLength(6);
    expect(descendantRows(10, rows).map((row) => row.pid)).toEqual([10, 11, 12, 13, 14]);
  });

  it('classifies Chrome roles without counting unrelated processes', () => {
    const rows = parsePsRows(snapshot);
    expect(classifyChromeProcess(rows[0], 10)).toBe('browser');
    expect(classifyChromeProcess(rows[1], 10)).toBe('gpu-process');
    expect(classifyChromeProcess(rows[2], 10)).toBe('renderer');
    expect(classifyChromeProcess(rows[3], 10)).toBe('utility-network');
    expect(classifyChromeProcess(rows[4], 10)).toBe('utility');

    expect(summarizeProcessRows(10, rows)).toEqual({
      processCount: 5,
      totalRssKiB: 240000,
      roles: {
        browser: { processCount: 1, rssKiB: 100000 },
        'gpu-process': { processCount: 1, rssKiB: 50000 },
        renderer: { processCount: 1, rssKiB: 60000 },
        'utility-network': { processCount: 1, rssKiB: 20000 },
        utility: { processCount: 1, rssKiB: 10000 },
      },
    });
  });

  it('summarizes macOS physical footprint by Chrome role and keeps graphics categories explicit', () => {
    const rows = parsePsRows(snapshot);
    const reports = [
      [10, 70000000],
      [11, 40000000],
      [12, 90000000],
      [13, 10000000],
      [14, 5000000],
    ].map(([pid, footprint]) => ({
      pid,
      process: {
        pid,
        footprint,
        categories: pid === 10 ? {
          MALLOC_LARGE: { dirty: 100000000, swapped: 1000000, clean: 0, reclaimable: 0, wired: 0, regions: 3 },
          IOAccelerator: { dirty: 30000000, swapped: 0, clean: 0, reclaimable: 0, wired: 2000000, regions: 4 },
          __TEXT: { dirty: 0, swapped: 0, clean: 80000000, reclaimable: 0, wired: 0, regions: 20 },
        } : {},
      },
    }));
    const summary = summarizeFootprintReport(10, rows, {
      processes: reports.map((entry) => entry.process),
      errors: [],
      warnings: ['synthetic warning'],
    });
    expect(summary).toMatchObject({
      targetProcessCount: 5,
      measuredProcessCount: 5,
      missingProcessCount: 0,
      complete: true,
      totalFootprintBytes: 215000000,
      roles: {
        browser: { processCount: 1, footprintBytes: 70000000 },
        'gpu-process': { processCount: 1, footprintBytes: 40000000 },
        renderer: { processCount: 1, footprintBytes: 90000000 },
        'utility-network': { processCount: 1, footprintBytes: 10000000 },
        utility: { processCount: 1, footprintBytes: 5000000 },
      },
      warnings: ['synthetic warning'],
    });
    expect(summary.topCategoriesByDirtyPlusSwappedBytes[0]).toMatchObject({
      name: 'MALLOC_LARGE',
      dirtyPlusSwappedBytes: 101000000,
    });
    expect(summary.graphicsCategories).toEqual([
      expect.objectContaining({ name: 'IOAccelerator', dirtyPlusSwappedBytes: 30000000, wired: 2000000 }),
    ]);
  });

  it('marks a footprint snapshot incomplete when a targeted Chrome child is absent', () => {
    const rows = parsePsRows(snapshot);
    const summary = summarizeFootprintReport(10, rows, {
      processes: [{ pid: 10, footprint: 70000000, categories: {} }],
      errors: [],
      warnings: [],
    });
    expect(summary.complete).toBe(false);
    expect(summary.missingProcessCount).toBe(4);
  });

  it('retains the highest summed RSS sample without mutating the previous peak', () => {
    const low = { processCount: 1, totalRssKiB: 100, roles: { browser: { processCount: 1, rssKiB: 100 } } };
    const high = { processCount: 2, totalRssKiB: 250, roles: { browser: { processCount: 1, rssKiB: 120 } } };
    const peak = mergePeak(low, high);
    expect(peak).toEqual(high);
    expect(peak).not.toBe(high);
    expect(mergePeak(peak, low)).toBe(peak);
  });

  it('retains the lowest summed RSS sample for teardown recovery evidence', () => {
    const low = { processCount: 1, totalRssKiB: 100, roles: { browser: { processCount: 1, rssKiB: 100 } } };
    const high = { processCount: 2, totalRssKiB: 250, roles: { browser: { processCount: 1, rssKiB: 120 } } };
    const minimum = mergeMinimum(high, low);
    expect(minimum).toEqual(low);
    expect(minimum).not.toBe(low);
    expect(mergeMinimum(minimum, high)).toBe(minimum);
  });
});

describe('endpoint post-stage WebGPU process RSS capture configuration', () => {
  it('keeps the existing defaults with a pure environment input', () => {
    const config = parseCaptureArgs(['relative-data', 'relative-output.json'], {});
    expect(config.serverPort).toBe(8796);
    expect(config.debugPort).toBe(9336);
    expect(config.sampleIntervalMs).toBe(100);
    expect(config.postReportSettleMs).toBe(5000);
    expect(config.postTeardownSettleMs).toBe(30000);
    expect(config.timeoutMs).toBe(120000);
    expect(config.dataDir).toMatch(/relative-data$/);
    expect(config.outputPath).toMatch(/relative-output\.json$/);
  });

  it('accepts explicit integer overrides including zero settle windows', () => {
    const config = parseCaptureArgs(['data', 'output.json'], {
      CHROME_BINARY: '/custom/chrome',
      UNZEN_HARNESS_PORT: '12001',
      UNZEN_CDP_PORT: '12002',
      UNZEN_RSS_SAMPLE_INTERVAL_MS: '25',
      UNZEN_RSS_POST_REPORT_SETTLE_MS: '0',
      UNZEN_RSS_POST_TEARDOWN_SETTLE_MS: '45000',
      UNZEN_RSS_TIMEOUT_MS: '180000',
    });
    expect(config).toMatchObject({
      chromeBinary: '/custom/chrome',
      serverPort: 12001,
      debugPort: 12002,
      sampleIntervalMs: 25,
      postReportSettleMs: 0,
      postTeardownSettleMs: 45000,
      timeoutMs: 180000,
    });
  });

  it.each([
    ['UNZEN_HARNESS_PORT', '0'],
    ['UNZEN_HARNESS_PORT', '65536'],
    ['UNZEN_CDP_PORT', 'not-a-number'],
    ['UNZEN_RSS_SAMPLE_INTERVAL_MS', '0'],
    ['UNZEN_RSS_SAMPLE_INTERVAL_MS', '1.5'],
    ['UNZEN_RSS_POST_REPORT_SETTLE_MS', '-1'],
    ['UNZEN_RSS_POST_TEARDOWN_SETTLE_MS', ''],
    ['UNZEN_RSS_TIMEOUT_MS', 'NaN'],
    ['UNZEN_RSS_TIMEOUT_MS', '-10'],
  ])('rejects malformed %s=%j before capture startup', (name, value) => {
    expect(() => parseCaptureArgs(['data', 'output.json'], { [name]: value }))
      .toThrow(new RegExp(name));
  });

  it('rejects a harness/CDP port collision before opening sockets', () => {
    expect(() => parseCaptureArgs(['data', 'output.json'], {
      UNZEN_HARNESS_PORT: '12001',
      UNZEN_CDP_PORT: '12001',
    })).toThrow(/must be distinct/);
  });

  it('rejects missing positional paths before reading environment overrides', () => {
    expect(() => parseCaptureArgs(['only-data'], {
      UNZEN_HARNESS_PORT: 'not-a-number',
    })).toThrow(/usage:/);
  });
});

it('keeps the browser phase marker and committed diagnostic evidence fail-closed', () => {
  const runner = readFileSync(
    new URL('../browser-harness/endpoint-poststage-tiled-webgpu/runner.js', import.meta.url),
    'utf8',
  );
  expect(runner).toContain('window.__unzenEndpointPoststageWebGpuPhase = value;');

  const evidence = JSON.parse(readFileSync(
    new URL('../docs/evidence/endpoint-poststage-webgpu-process-rss-20260908.json', import.meta.url),
    'utf8',
  ));
  expect(evidence).toMatchObject({
    schemaVersion: '1.0.0',
    kind: 'unzen-endpoint-poststage-webgpu-process-rss-diagnostic',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'captured-os-process-rss',
  });
  expect(evidence.capturedAtUtc).toMatch(/^2026-09-08T/);
  expect(evidence.runtimeReport).toMatchObject({
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    sessionReleaseApiCompleted: true,
  });
  expect(evidence.measurement.sampleIntervalMs).toBe(100);
  expect(evidence.measurement.postReportSettleMs).toBe(5000);
  expect(evidence.measurement.globalPeak.totalRssKiB)
    .toBeGreaterThan(evidence.measurement.baseline.totalRssKiB);
  expect(evidence.measurement.afterAllSessionReleaseApisReturned.finalAfterSettle.totalRssKiB)
    .toBeGreaterThan(0);
  expect(evidence.limitations).toContain(
    'RSS is an OS process metric, not a WebGPU/Metal allocation metric.',
  );
});

it('records document-teardown recovery separately from session-release settling', () => {
  const evidence = JSON.parse(readFileSync(
    new URL('../docs/evidence/endpoint-poststage-webgpu-process-rss-teardown-20260908.json', import.meta.url),
    'utf8',
  ));
  expect(evidence).toMatchObject({
    schemaVersion: '1.1.0',
    kind: 'unzen-endpoint-poststage-webgpu-process-rss-diagnostic',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'captured-os-process-rss',
  });
  expect(evidence.capturedAtUtc).toMatch(/^2026-09-08T/);
  expect(evidence.measurement.postReportSettleMs).toBe(5000);
  expect(evidence.measurement.postDocumentTeardownSettleMs).toBe(30000);
  expect(evidence.runtimeReport).toMatchObject({
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    sessionReleaseApiCompleted: true,
  });
  const baseline = evidence.measurement.baseline.totalRssKiB;
  const teardown = evidence.measurement.afterDocumentTeardown;
  expect(teardown.baselineRssKiB).toBe(baseline);
  expect(teardown.firstAtOrBelowBaseline).not.toBeNull();
  expect(teardown.firstAtOrBelowBaseline.elapsedMs).toBeGreaterThan(0);
  expect(teardown.firstAtOrBelowBaseline.totalRssKiB).toBeLessThanOrEqual(baseline);
  expect(teardown.minimumDuringSettle.totalRssKiB).toBeLessThanOrEqual(baseline);
  expect(teardown.finalAfterSettle.totalRssKiB).toBeGreaterThan(0);
  expect(evidence.limitations).toContain(
    'Navigating to about:blank tears down the measured document context but Chrome may retain renderer processes, reusable allocator pages, driver caches, or shared mappings.',
  );
});

it('records macOS physical-footprint milestones without promoting partial teardown data', () => {
  const evidence = JSON.parse(readFileSync(
    new URL('../docs/evidence/endpoint-poststage-webgpu-physical-footprint-20260908.json', import.meta.url),
    'utf8',
  ));
  expect(evidence).toMatchObject({
    schemaVersion: '1.2.0',
    kind: 'unzen-endpoint-poststage-webgpu-process-rss-diagnostic',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'captured-os-process-rss+partial-macos-physical-footprint',
  });
  const footprint = evidence.measurement.macosPhysicalFootprint;
  expect(footprint).toMatchObject({
    milestoneCount: 5,
    completeMilestoneCount: 4,
    completeAcrossMilestones: false,
  });
  expect(footprint.baseline.complete).toBe(true);
  expect(footprint.afterAllSessionReleaseApisReturned.finalAfterSettle.complete).toBe(true);
  expect(footprint.afterDocumentTeardown.finalAfterSettle.complete).toBe(false);
  expect(footprint.afterDocumentTeardown.finalAfterSettle.missingProcesses).toEqual([
    expect.objectContaining({ role: 'browser-child' }),
  ]);
  expect(footprint.afterAllSessionReleaseApisReturned.finalAfterSettle.totalFootprintBytes)
    .toBeGreaterThan(footprint.baseline.totalFootprintBytes);
  expect(footprint.afterAllSessionReleaseApisReturned.finalAfterSettle.graphicsCategories)
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Owned physical footprint (unmapped) (graphics)' }),
    ]));
  expect(evidence.runtimeReport.logitsComparison.maxAbsDiff).toBeLessThan(1e-4);
});
