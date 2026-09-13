import { describe, expect, it } from 'vitest';
import {
  AllowlistedPrototypeTransport,
  SimulatedPrototypeWorker,
  TwoWorkerPrototypeRunner,
  TWO_WORKER_PROTOTYPE_SEGMENTS,
  type PrototypeWorkerOptions,
} from '../src/two-worker-prototype.js';

describe('SimulatedPrototypeWorker runtime options', () => {
  it.each([
    null,
    undefined,
    42,
    'worker',
    [],
    Symbol('worker-options'),
    () => undefined,
  ])('rejects malformed top-level option containers before field access', (options) => {
    expect(() => new SimulatedPrototypeWorker(
      options as unknown as PrototypeWorkerOptions,
    )).toThrow(/prototype worker options must be a non-null object/);
  });

  it.each([-1, 2, 0.5, '0', null, undefined, Symbol('segment')])(
    'rejects invalid segment indexes',
    (segmentIndex) => {
      expect(() => new SimulatedPrototypeWorker({
        id: 'worker-a',
        segmentIndex: segmentIndex as 0,
        webgpuAdapter: 'adapter-a',
        vramMB: 4096,
      })).toThrow(/prototype worker segmentIndex must be 0 or 1/);
    },
  );

  it.each([null, undefined, 42, {}, [], Symbol('adapter'), '', '   '])(
    'rejects malformed WebGPU adapter metadata',
    (webgpuAdapter) => {
      expect(() => new SimulatedPrototypeWorker({
        id: 'worker-a',
        segmentIndex: 0,
        webgpuAdapter: webgpuAdapter as string,
        vramMB: 4096,
      })).toThrow(/prototype worker webgpuAdapter must be a non-empty string/);
    },
  );

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '4096',
    null,
    undefined,
    {},
    [],
    Symbol('vram'),
  ])('rejects malformed VRAM metadata', (vramMB) => {
    expect(() => new SimulatedPrototypeWorker({
      id: 'worker-a',
      segmentIndex: 0,
      webgpuAdapter: 'adapter-a',
      vramMB: vramMB as number,
    })).toThrow(/prototype worker vramMB must be a positive finite number/);
  });

  it.each([null, 0, 1, 'false', {}, [], Symbol('fail-first')])(
    'rejects malformed failFirstRun flags',
    (failFirstRun) => {
      expect(() => new SimulatedPrototypeWorker({
        id: 'worker-a',
        segmentIndex: 0,
        webgpuAdapter: 'adapter-a',
        vramMB: 4096,
        failFirstRun: failFirstRun as boolean,
      })).toThrow(/prototype worker failFirstRun must be a boolean when provided/);
    },
  );

  it('preserves valid metadata and undefined failFirstRun defaults', () => {
    const worker = new SimulatedPrototypeWorker({
      id: 'worker-a',
      segmentIndex: 0,
      webgpuAdapter: 'adapter-a',
      vramMB: 4096,
    });

    expect(worker.id).toBe('worker-a');
    expect(worker.segmentIndex).toBe(0);
    expect(worker.snapshotMetadata()).toEqual({
      webgpuAdapter: 'adapter-a',
      tier: 'tier-2',
      vramMB: 4096,
      cachedSegments: [],
    });
  });
});

describe('TwoWorkerPrototypeRunner', () => {
  it('compares the fixed 2-worker split path with the single-worker reference path', async () => {
    const runner = new TwoWorkerPrototypeRunner({
      segment1Primary: new SimulatedPrototypeWorker({
        id: 'seg1-primary',
        segmentIndex: 1,
        webgpuAdapter: 'mock-webgpu-b',
        vramMB: 4096,
        failFirstRun: false,
      }),
    });

    const report = await runner.run({ prompt: 'hello from the prototype' });

    expect(report.referenceText).toBe('proto-2b:HELLO FROM THE PROTOTYPE');
    expect(report.splitText).toBe(report.referenceText);
    expect(report.matchesReference).toBe(true);
    expect(report.segments).toHaveLength(2);
    expect(report.segments.map((segment) => segment.segmentIndex)).toEqual([0, 1]);
    expect(TWO_WORKER_PROTOTYPE_SEGMENTS).toHaveLength(2);
  });

  it('retries segment 1 from the relayed checkpoint when the primary worker is lost', async () => {
    const runner = new TwoWorkerPrototypeRunner();

    const report = await runner.run({ prompt: 'resume me' });
    const segment0 = report.segments[0];
    const segment1 = report.segments[1];

    expect(report.matchesReference).toBe(true);
    expect(report.checkpointRelayBytes).toBeGreaterThan(0);
    expect(segment0.checkpointBytes).toBe(report.checkpointRelayBytes);
    expect(segment1.retryCount).toBe(1);
    expect(segment1.workerId).toBe('proto-worker-seg1-standby');
    expect(segment1.checkpointBytes).toBe(report.checkpointRelayBytes);
  });

  it('reports warm segment-artifact cache hits on a second run', async () => {
    const runner = new TwoWorkerPrototypeRunner({
      segment1Primary: new SimulatedPrototypeWorker({
        id: 'seg1-primary',
        segmentIndex: 1,
        webgpuAdapter: 'mock-webgpu-b',
        vramMB: 4096,
        failFirstRun: false,
      }),
    });

    const coldReport = await runner.run({ prompt: 'cache probe 日本語' });
    const warmReport = await runner.run({ prompt: 'cache probe 日本語' });

    expect(coldReport.segments.map((segment) => segment.cacheHit)).toEqual([false, false]);
    expect(warmReport.segments.map((segment) => segment.cacheHit)).toEqual([true, true]);
    expect(warmReport.splitText).toBe('proto-2b:CACHE PROBE 日本語');
    expect(warmReport.transport.connections).toHaveLength(coldReport.transport.connections.length);
    expect(warmReport.segments[0].workerMetadata.cachedSegments).toEqual([0]);
    expect(warmReport.segments[1].workerMetadata.cachedSegments).toEqual([1]);
  });

  it('keeps simulated workers inside Coordinator and CDN transport allowlists', async () => {
    const transport = new AllowlistedPrototypeTransport([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);
    const runner = new TwoWorkerPrototypeRunner({
      transport,
      segment1Primary: new SimulatedPrototypeWorker({
        id: 'seg1-primary',
        segmentIndex: 1,
        webgpuAdapter: 'mock-webgpu-b',
        vramMB: 4096,
        failFirstRun: false,
      }),
    });

    const report = await runner.run({ prompt: 'network boundary' });

    expect(new Set(report.transport.connections)).toEqual(new Set([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]));
    expect(() => transport.connect('https://worker-peer.example/direct')).toThrow(
      /outside prototype allowlist/,
    );
  });
});
