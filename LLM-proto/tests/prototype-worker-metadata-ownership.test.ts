import { describe, expect, it } from 'vitest';
import {
  AllowlistedPrototypeTransport,
  SimulatedPrototypeWorker,
} from '../src/two-worker-prototype.js';
import { WorkerTier } from '../src/types.js';

describe('SimulatedPrototypeWorker metadata ownership', () => {
  it('prevents callers from rewriting worker report metadata or cache authority', async () => {
    const worker = new SimulatedPrototypeWorker({
      id: 'worker-metadata',
      segmentIndex: 0,
      webgpuAdapter: 'adapter-original',
      vramMB: 4096,
    });

    expect(Object.isFrozen(worker.metadata)).toBe(true);
    expect(Object.isFrozen(worker.metadata.cachedSegments)).toBe(true);

    const mutableMetadata = worker.metadata as unknown as {
      webgpuAdapter: string;
      tier: WorkerTier;
      vramMB: number;
      cachedSegments: number[];
    };
    expect(() => {
      mutableMetadata.webgpuAdapter = 'adapter-forged';
    }).toThrow();
    expect(() => {
      mutableMetadata.tier = WorkerTier.TIER_1;
    }).toThrow();
    expect(() => {
      mutableMetadata.vramMB = 1;
    }).toThrow();
    expect(() => mutableMetadata.cachedSegments.push(99)).toThrow();

    expect(worker.snapshotMetadata()).toEqual({
      webgpuAdapter: 'adapter-original',
      tier: WorkerTier.TIER_2,
      vramMB: 4096,
      cachedSegments: [],
    });

    const transport = new AllowlistedPrototypeTransport([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);
    await worker.execute({
      requestId: 'metadata-req-1',
      prompt: 'metadata ownership',
      coordinatorUrl: 'https://coordinator.unzen.local',
      cdnUrl: 'https://cdn.unzen.local',
      transport,
    });

    expect(worker.snapshotMetadata()).toEqual({
      webgpuAdapter: 'adapter-original',
      tier: WorkerTier.TIER_2,
      vramMB: 4096,
      cachedSegments: [0],
    });
  });
});
