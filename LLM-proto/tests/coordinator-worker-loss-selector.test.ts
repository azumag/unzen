import { describe, expect, it } from 'vitest';
import {
  buildCoordinatorPrototypeSegments,
  runCoordinatorPrototype,
} from '../src/coordinator-prototype.js';
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

function createAlternatingWorkerManifest() {
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
});
