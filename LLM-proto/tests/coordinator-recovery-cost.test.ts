import { describe, expect, it, vi } from 'vitest';
import { buildCoordinatorPrototypeSegments, createDefaultCoordinatorPrototypeManifest, runCoordinatorPrototype, type CoordinatorPrototypeManifest } from '../src/coordinator-prototype.js';
import { AllowlistedPrototypeTransport } from '../src/two-worker-prototype.js';
import { WorkerTier } from '../src/types.js';

function rollingManifest(): CoordinatorPrototypeManifest {
  return {
    requestId: 'rolling-recovery-cost', prompt: 'test',
    segments: buildCoordinatorPrototypeSegments(2),
    workers: [{ id: 'rolling-worker', tier: WorkerTier.TIER_2, lastHeartbeatMs: 0,
      telemetry: { uptimeMs: 2 * 60 * 60 * 1000, vramFreeMB: 3_600,
        gpuBusyRatio: 0.024, cpuBusyRatio: 0.01, cacheHits: [], tokensPerSecond: 18,
        checkpointBytesPerSecond: 0, failureRate: 0, heartbeatJitterMs: 25 } }],
    lostWorkerId: 'rolling-worker', lostAfterAssignmentIndex: 1,
  };
}

describe('Coordinator recovery checkpoint cost', () => {
  it('estimates recovery independently after a zero-transfer rolling boundary', () => {
    const report = runCoordinatorPrototype(rollingManifest());
    expect(report.assignments.map((a) => a.workerId)).toEqual(['rolling-worker', 'rolling-worker']);
    expect(report.assignments[1]).toMatchObject({ rollingConsecutive: true, checkpointTransferBytes: 0, checkpointTransferMs: 0 });
    expect(report.checkpointRelay).toEqual([]);
    expect(report.retryResumeImpact).toEqual({
      retryCount: 1, resumeCount: 1, affectedSegments: [1], resumedFromSegment: 0,
      addedCheckpointDelayMs: 550,
      recoveryCost: { checkpointBytes: 4 * 1024 * 1024, checkpointTransferMs: 500,
        bytesPerSecond: 8 * 1024 * 1024, source: 'prototype-default-rate',
        retryOverheadMs: 50, via: 'coordinator', evidence: 'estimated' },
      failureReason: 'worker-lost: rolling-worker',
    });
    expect(report.bottlenecksToIssue).toContain('checkpoint-relay-latency-budget');
    expect(report.transport.connections.every((url) => ['https://coordinator.unzen.local', 'https://cdn.unzen.local'].includes(new URL(url).origin))).toBe(true);
  });

  it('changes only recovery cost when configured recovery throughput changes', () => {
    const baseline = runCoordinatorPrototype(rollingManifest());
    const faster = runCoordinatorPrototype({ ...rollingManifest(), recoveryCheckpointBytesPerSecond: 16 * 1024 * 1024 });
    expect(faster.assignments).toEqual(baseline.assignments);
    expect(faster.checkpointRelay).toEqual(baseline.checkpointRelay);
    expect(faster.transport).toEqual(baseline.transport);
    expect(faster.retryResumeImpact.addedCheckpointDelayMs).toBe(300);
    expect(faster.retryResumeImpact.recoveryCost).toMatchObject({ checkpointTransferMs: 250, source: 'prototype-configured-rate' });
  });

  it('uses custom checkpoint bytes when all original transfers are zero', () => {
    const report = runCoordinatorPrototype({ ...rollingManifest(), checkpointBytes: 2 * 1024 * 1024 });
    expect(report.assignments.every((a) => a.checkpointTransferBytes === 0)).toBe(true);
    expect(report.retryResumeImpact.recoveryCost).toMatchObject({ checkpointBytes: 2 * 1024 * 1024, checkpointTransferMs: 250 });
  });

  it('does not double count the original cross-worker transfer', () => {
    const report = runCoordinatorPrototype(createDefaultCoordinatorPrototypeManifest());
    expect(report.assignments[1].checkpointTransferBytes).toBeGreaterThan(0);
    expect(report.assignments[1].checkpointTransferMs).toBeGreaterThan(0);
    expect(report.retryResumeImpact.addedCheckpointDelayMs).toBe(550);
  });

  it('has no checkpoint transfer before the first completed assignment', () => {
    const report = runCoordinatorPrototype({ ...rollingManifest(), lostAfterAssignmentIndex: 0 });
    expect(report.retryResumeImpact).toMatchObject({ retryCount: 1, resumeCount: 0, addedCheckpointDelayMs: 50,
      recoveryCost: { checkpointBytes: 0, checkpointTransferMs: 0, retryOverheadMs: 50 } });
    expect(report.retryResumeImpact.resumedFromSegment).toBeUndefined();
  });

  it.each([
    { lostWorkerId: undefined, lostAfterAssignmentIndex: undefined },
    { lostWorkerId: 'unassigned', lostAfterAssignmentIndex: 0 },
    { lostWorkerId: 'rolling-worker', lostAfterAssignmentIndex: 2 },
  ])('preserves the exact no-loss shape for %j', (selector) => {
    expect(runCoordinatorPrototype({ ...rollingManifest(), ...selector }).retryResumeImpact).toEqual({
      retryCount: 0, resumeCount: 0, affectedSegments: [], addedCheckpointDelayMs: 0 });
  });

  it.each([0, -1, NaN, Infinity, -Infinity, null, '8388608', Number.MIN_VALUE, 1e-20])(
    'rejects invalid or overflowing recovery rates before transport: %s', (rate) => {
      const connect = vi.spyOn(AllowlistedPrototypeTransport.prototype, 'connect');
      try {
        expect(() => runCoordinatorPrototype({ ...rollingManifest(), recoveryCheckpointBytesPerSecond: rate as number })).toThrow(/recovery/);
        expect(connect).not.toHaveBeenCalled();
      } finally { connect.mockRestore(); }
    });

  it.each([0, -1, 1.5, NaN, Infinity, null, '4194304'])(
    'rejects invalid checkpoint sizes before transport: %s', (bytes) => {
      const connect = vi.spyOn(AllowlistedPrototypeTransport.prototype, 'connect');
      try {
        expect(() => runCoordinatorPrototype({
          ...rollingManifest(), checkpointBytes: bytes as number,
        })).toThrow('checkpointBytes must be a positive safe integer');
        expect(connect).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
      }
    },
  );

  it('rounds a positive sub-millisecond transfer up and remains JSON-safe', () => {
    const report = runCoordinatorPrototype({ ...rollingManifest(), checkpointBytes: 1, recoveryCheckpointBytesPerSecond: Number.MAX_VALUE });
    expect(report.retryResumeImpact.recoveryCost?.checkpointTransferMs).toBe(1);
    expect(JSON.parse(JSON.stringify(report)).retryResumeImpact).toEqual(report.retryResumeImpact);
  });

  it('shares one checkpoint-size and recovery-rate snapshot across dispatch and reporting', () => {
    const manifest = createDefaultCoordinatorPrototypeManifest();
    let bytesReads = 0;
    let rateReads = 0;
    Object.defineProperty(manifest, 'checkpointBytes', { get() { return ++bytesReads === 1 ? 2 * 1024 * 1024 : 0; } });
    Object.defineProperty(manifest, 'recoveryCheckpointBytesPerSecond', { get() { return ++rateReads === 1 ? 4 * 1024 * 1024 : 0; } });
    const report = runCoordinatorPrototype(manifest);
    expect(bytesReads).toBe(1);
    expect(rateReads).toBe(1);
    expect(report.assignments[1].checkpointTransferBytes).toBe(2 * 1024 * 1024);
    expect(report.retryResumeImpact.recoveryCost).toMatchObject({ checkpointBytes: 2 * 1024 * 1024,
      bytesPerSecond: 4 * 1024 * 1024, checkpointTransferMs: 500, source: 'prototype-configured-rate' });
  });
});
