import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyChromeProcess,
  descendantRows,
  mergePeak,
  parsePsRows,
  summarizeProcessRows,
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

  it('retains the highest summed RSS sample without mutating the previous peak', () => {
    const low = { processCount: 1, totalRssKiB: 100, roles: { browser: { processCount: 1, rssKiB: 100 } } };
    const high = { processCount: 2, totalRssKiB: 250, roles: { browser: { processCount: 1, rssKiB: 120 } } };
    const peak = mergePeak(low, high);
    expect(peak).toEqual(high);
    expect(peak).not.toBe(high);
    expect(mergePeak(peak, low)).toBe(peak);
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
