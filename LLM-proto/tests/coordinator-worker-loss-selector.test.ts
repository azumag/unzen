import { describe, expect, it, vi } from 'vitest';
import {
  buildCoordinatorPrototypeSegments,
  runCoordinatorPrototype,
  type CoordinatorPrototypeManifest,
} from '../src/coordinator-prototype.js';
import { AllowlistedPrototypeTransport } from '../src/two-worker-prototype.js';
import { WorkerTier } from '../src/types.js';

const telemetry = {
  uptimeMs: 90_000,
  vramFreeMB: 3_600,
  gpuBusyRatio: 0.01,
  cpuBusyRatio: 0.01,
  cacheHits: [] as number[],
  tokensPerSecond: 18,
  checkpointBytesPerSecond: 8 * 1024 * 1024,
  failureRate: 0,
  heartbeatJitterMs: 25,
};

function createAlternatingWorkerManifest(): CoordinatorPrototypeManifest {
  return {
    requestId: 'worker-loss-selector',
    prompt: 'test',
    segments: buildCoordinatorPrototypeSegments(2),
    workers: [
      {
        id: 'visitor-a',
        tier: WorkerTier.TIER_3,
        lastHeartbeatMs: 0,
        telemetry,
      },
      {
        id: 'visitor-b',
        tier: WorkerTier.TIER_3,
        lastHeartbeatMs: 0,
        telemetry,
      },
    ],
  };
}

describe('Coordinator worker-loss selector', () => {
  it('does not fall back to a different worker when the requested worker has no later assignment', () => {
    const report = runCoordinatorPrototype({
      ...createAlternatingWorkerManifest(),
      lostWorkerId: 'visitor-a',
      lostAfterAssignmentIndex: 1,
    });

    expect(report.status).toBe('pass');
    expect(report.assignments.map((assignment) => assignment.workerId)).toEqual([
      'visitor-a',
      'visitor-b',
    ]);
    expect(report.retryResumeImpact).toEqual({
      retryCount: 0,
      resumeCount: 0,
      affectedSegments: [],
      addedCheckpointDelayMs: 0,
    });
  });

  it('keeps index-only loss selection when no worker id is requested', () => {
    const report = runCoordinatorPrototype({
      ...createAlternatingWorkerManifest(),
      lostAfterAssignmentIndex: 1,
    });

    expect(report.status).toBe('pass');
    expect(report.assignments.map((assignment) => assignment.workerId)).toEqual([
      'visitor-a',
      'visitor-b',
    ]);
    expect(report.retryResumeImpact).toMatchObject({
      retryCount: 1,
      resumeCount: 1,
      failureReason: 'worker-lost: visitor-b',
    });
  });

  it('searches from the first assignment when a worker id is supplied without an index', () => {
    const report = runCoordinatorPrototype({
      ...createAlternatingWorkerManifest(),
      lostWorkerId: 'visitor-a',
    });

    expect(report.status).toBe('pass');
    expect(report.retryResumeImpact).toMatchObject({
      retryCount: 1,
      resumeCount: 0,
      failureReason: 'worker-lost: visitor-a',
    });
  });

  it('rejects malformed explicit worker ids before simulated transport connections', () => {
    const connectSpy = vi.spyOn(AllowlistedPrototypeTransport.prototype, 'connect');
    const invalidWorkerIds = [
      '',
      '   ',
      7 as unknown as string,
    ];

    try {
      for (const lostWorkerId of invalidWorkerIds) {
        expect(() => runCoordinatorPrototype({
          ...createAlternatingWorkerManifest(),
          lostWorkerId,
          lostAfterAssignmentIndex: 0,
        })).toThrow('workerId must be a non-empty string');
      }
      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
    }
  });

  it('captures accessor-backed worker-loss selectors exactly once before dispatch', () => {
    const manifest = createAlternatingWorkerManifest();
    let workerIdReads = 0;
    let indexReads = 0;

    Object.defineProperty(manifest, 'lostWorkerId', {
      configurable: true,
      get() {
        workerIdReads += 1;
        return workerIdReads === 1 ? 'visitor-a' : 'visitor-b';
      },
    });
    Object.defineProperty(manifest, 'lostAfterAssignmentIndex', {
      configurable: true,
      get() {
        indexReads += 1;
        return indexReads === 1 ? 0 : 1;
      },
    });

    const report = runCoordinatorPrototype(manifest);

    expect(workerIdReads).toBe(1);
    expect(indexReads).toBe(1);
    expect(report.retryResumeImpact).toMatchObject({
      retryCount: 1,
      resumeCount: 0,
      failureReason: 'worker-lost: visitor-a',
    });
  });

  it('rejects malformed explicit loss indexes before simulated transport connections', () => {
    const connectSpy = vi.spyOn(AllowlistedPrototypeTransport.prototype, 'connect');
    const invalidIndexes = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    try {
      for (const lostAfterAssignmentIndex of invalidIndexes) {
        expect(() => runCoordinatorPrototype({
          ...createAlternatingWorkerManifest(),
          lostWorkerId: 'visitor-a',
          lostAfterAssignmentIndex,
        })).toThrow('lostAfterAssignmentIndex must be a non-negative safe integer');
      }
      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
    }
  });
});
