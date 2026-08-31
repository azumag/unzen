import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { SpanRouter } from '../src/span-router.js';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerTier, type SegmentConfig } from '../src/types.js';
import { makeSegments } from './test-helpers.js';

function makeManifestBackedSegments(
  vramBySegment: readonly number[],
  bytesBySegment: readonly number[] = vramBySegment.map((value) => value * 1024 * 1024),
): { readonly segments: SegmentConfig[]; readonly artifacts: SegmentArtifact[] } {
  const artifacts = vramBySegment.map((estimatedMemoryMB, index): SegmentArtifact => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize: bytesBySegment[index],
    sha256: (index + 1).toString(16).padStart(64, '0'),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/model/segment-${index}.onnx`,
    estimatedMemoryMB,
    memoryBasis: 'measured',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  }));
  return {
    artifacts,
    segments: artifacts.map((artifact) => ({
      index: artifact.index,
      layerStart: artifact.layerStart,
      layerEnd: artifact.layerEnd,
      modelWeightHash: artifact.sha256,
      estimatedVramMB: artifact.estimatedMemoryMB,
    })),
  };
}

describe('SpanRouter', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    pool = new WorkerPool();
  });

  it('should return null when no workers are available', () => {
    const router = new SpanRouter(makeSegments(8), pool);
    expect(router.computeRoute()).toBeNull();
  });

  it('should return empty route for empty segments', () => {
    const router = new SpanRouter([], pool);
    expect(router.computeRoute()).toEqual([]);
  });

  it('should assign all segments to one worker if VRAM allows', () => {
    // Worker with 8GB can handle all 4 segments (4 × 2100 = 8400 ≤ 8400)
    pool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_1,
      vramMB: 8400,
    });

    const segments = makeSegments(4);
    const router = new SpanRouter(segments, pool);
    const route = router.computeRoute();

    expect(route).not.toBeNull();
    expect(route).toHaveLength(1);
    expect(route![0]).toEqual({
      workerId: workerId('w1'),
      startSegment: 0,
      endSegment: 3,
    });
  });

  it('should split across multiple workers when VRAM is limited', () => {
    // Each worker can handle 2 segments (2 × 2100 = 4200)
    pool.register({ workerId: workerId('w1'), tier: WorkerTier.TIER_2, vramMB: 4200 });
    pool.register({ workerId: workerId('w2'), tier: WorkerTier.TIER_2, vramMB: 4200 });

    const segments = makeSegments(4);
    const router = new SpanRouter(segments, pool);
    const route = router.computeRoute();

    expect(route).not.toBeNull();
    expect(route).toHaveLength(2);
    // Each worker handles a span of 2 segments
    expect(route![0]).toEqual({ workerId: workerId('w1'), startSegment: 0, endSegment: 1 });
    expect(route![1]).toEqual({ workerId: workerId('w2'), startSegment: 2, endSegment: 3 });
  });

  it('should fall back to 1 segment per worker when VRAM is minimal', () => {
    // Each worker can handle exactly 1 segment
    for (let i = 0; i < 4; i++) {
      pool.register({ workerId: workerId(`w${i}`), tier: WorkerTier.TIER_3, vramMB: 2100 });
    }

    const segments = makeSegments(4);
    const router = new SpanRouter(segments, pool);
    const route = router.computeRoute();

    expect(route).not.toBeNull();
    expect(route).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(route![i].startSegment).toBe(i);
      expect(route![i].endSegment).toBe(i);
    }
  });

  it('should return null when workers cannot cover all segments', () => {
    // Only 2 workers, each can handle 1 segment, but 4 segments total
    pool.register({ workerId: workerId('w1'), tier: WorkerTier.TIER_3, vramMB: 2100 });
    pool.register({ workerId: workerId('w2'), tier: WorkerTier.TIER_3, vramMB: 2100 });

    const segments = makeSegments(4);
    const router = new SpanRouter(segments, pool);
    expect(router.computeRoute()).toBeNull();
  });

  it('should prefer Tier 1 workers for larger spans', () => {
    // Tier 1 worker: 4 segments capacity
    // Tier 3 workers: 1 segment each
    pool.register({ workerId: workerId('t1'), tier: WorkerTier.TIER_1, vramMB: 8400 });
    pool.register({ workerId: workerId('t3a'), tier: WorkerTier.TIER_3, vramMB: 2100 });
    pool.register({ workerId: workerId('t3b'), tier: WorkerTier.TIER_3, vramMB: 2100 });

    const segments = makeSegments(4);
    const router = new SpanRouter(segments, pool);
    const route = router.computeRoute();

    expect(route).not.toBeNull();
    // Tier 1 should get the first (and largest) span
    expect(route![0].workerId).toBe(workerId('t1'));
    expect(route![0].startSegment).toBe(0);
    // Tier 1 can handle all 4, so it should get all of them
    expect(route![0].endSegment).toBe(3);
    expect(route).toHaveLength(1);
  });

  it('should handle mixed VRAM capacities optimally', () => {
    // Worker A: 8GB → 3 segments (3 × 2100 = 6300 ≤ 8000)
    // Worker B: 4GB → 1 segment (1 × 2100 = 2100 ≤ 4000)
    pool.register({ workerId: workerId('A'), tier: WorkerTier.TIER_2, vramMB: 8000 });
    pool.register({ workerId: workerId('B'), tier: WorkerTier.TIER_2, vramMB: 4000 });

    const segments = makeSegments(4);
    const router = new SpanRouter(segments, pool);
    const route = router.computeRoute();

    expect(route).not.toBeNull();
    expect(route).toHaveLength(2);
    // Worker A handles first 3 segments
    expect(route![0]).toEqual({ workerId: workerId('A'), startSegment: 0, endSegment: 2 });
    // Worker B handles the remaining 1 segment
    expect(route![1]).toEqual({ workerId: workerId('B'), startSegment: 3, endSegment: 3 });
  });

  it('should skip disconnected and busy workers', () => {
    pool.register({ workerId: workerId('disconnected'), tier: WorkerTier.TIER_1, vramMB: 16000 });
    pool.register({ workerId: workerId('busy'), tier: WorkerTier.TIER_1, vramMB: 16000 });
    pool.register({ workerId: workerId('idle'), tier: WorkerTier.TIER_3, vramMB: 8400 });

    pool.markDisconnected(workerId('disconnected'));
    pool.markBusy(workerId('busy'), 0);

    const segments = makeSegments(4);
    const router = new SpanRouter(segments, pool);
    const route = router.computeRoute();

    expect(route).not.toBeNull();
    expect(route).toHaveLength(1);
    expect(route![0].workerId).toBe(workerId('idle'));
  });

  it('should skip workers with insufficient VRAM', () => {
    // Worker with 1000MB cannot handle even 1 segment (2100MB needed)
    pool.register({ workerId: workerId('small'), tier: WorkerTier.TIER_1, vramMB: 1000 });
    pool.register({ workerId: workerId('ok'), tier: WorkerTier.TIER_3, vramMB: 8400 });

    const segments = makeSegments(4);
    const router = new SpanRouter(segments, pool);
    const route = router.computeRoute();

    expect(route).not.toBeNull();
    expect(route![0].workerId).toBe(workerId('ok'));
  });

  it('should produce route covering all segments exactly once', () => {
    // w1: 3 segments, w2: 3 segments, w3: 2 segments = 8 total
    pool.register({ workerId: workerId('w1'), tier: WorkerTier.TIER_2, vramMB: 6300 });
    pool.register({ workerId: workerId('w2'), tier: WorkerTier.TIER_3, vramMB: 6300 });
    pool.register({ workerId: workerId('w3'), tier: WorkerTier.TIER_3, vramMB: 4200 });

    const segments = makeSegments(8);
    const router = new SpanRouter(segments, pool);
    const route = router.computeRoute();

    expect(route).not.toBeNull();

    // Verify full coverage: every segment 0-7 is covered exactly once
    const covered = new Set<number>();
    for (const span of route!) {
      for (let s = span.startSegment; s <= span.endSegment; s++) {
        expect(covered.has(s)).toBe(false); // no overlap
        covered.add(s);
      }
    }
    expect(covered.size).toBe(8);

    // Verify contiguity: spans are ordered and non-overlapping
    for (let i = 1; i < route!.length; i++) {
      expect(route![i].startSegment).toBe(route![i - 1].endSegment + 1);
    }
  });

  it('supports unequal segment VRAM estimates from byte-budgeted splitting', () => {
    pool.register({ workerId: workerId('wide'), tier: WorkerTier.TIER_2, vramMB: 4000 });
    pool.register({ workerId: workerId('edge'), tier: WorkerTier.TIER_2, vramMB: 1000 });

    const { segments } = makeManifestBackedSegments([1000, 3000, 1000]);
    const route = new SpanRouter(segments, pool).computeRoute();

    expect(route).toEqual([
      { workerId: workerId('wide'), startSegment: 0, endSegment: 1 },
      { workerId: workerId('edge'), startSegment: 2, endSegment: 2 },
    ]);
  });

  it('prefers a worker with an adjacent resident artifact prefix and groups it as a span', () => {
    const cachedVisitor = workerId('cached-visitor');
    const coldStable = workerId('cold-stable');
    pool.register({ workerId: coldStable, tier: WorkerTier.TIER_1, vramMB: 4200 });
    pool.register({ workerId: cachedVisitor, tier: WorkerTier.TIER_3, vramMB: 4200 });

    const { segments, artifacts } = makeManifestBackedSegments(
      [2100, 2100, 2100, 2100],
      [100, 200, 300, 400],
    );
    const ledger = new ArtifactResidencyLedger(artifacts);
    ledger.synchronizeWorker(cachedVisitor, [0, 1]);

    const route = new SpanRouter(segments, pool, ledger).computeRoute();

    expect(route).toEqual([
      { workerId: cachedVisitor, startSegment: 0, endSegment: 1 },
      { workerId: coldStable, startSegment: 2, endSegment: 3 },
    ]);
  });

  it('fails closed when the residency inventory belongs to another segment geometry', () => {
    const { artifacts } = makeManifestBackedSegments([2100, 2100]);
    const ledger = new ArtifactResidencyLedger(artifacts);
    const mismatched = makeSegments(2);

    expect(() => new SpanRouter(mismatched, pool, ledger)).toThrow(/hash does not match/);
  });
});
