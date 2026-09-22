import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type CachedArtifactIdentity,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import { workerId, WorkerTier } from '../src/types.js';
import { makeSegments } from './test-helpers.js';

const baseTelemetry: WorkerTelemetry = {
  uptimeMs: 2 * 60 * 60 * 1000,
  vramFreeMB: 8400,
  gpuBusyRatio: 0.01,
  cpuBusyRatio: 0.01,
  cacheHits: [0],
  tokensPerSecond: 18,
  checkpointBytesPerSecond: 8 * 1024 * 1024,
  failureRate: 0,
  heartbeatJitterMs: 25,
};

const malformedTelemetryCases: readonly [unknown, RegExp][] = [
  [null, /worker telemetry must be a non-null object/],
  [42, /worker telemetry must be a non-null object/],
  [[], /worker telemetry must be a non-null object/],
  [{ ...baseTelemetry, cacheHits: '0' }, /cacheHits must be an array/],
  [{ ...baseTelemetry, cacheHits: [Symbol('bad-cache-hit')] }, /cache hit segment must be a number/],
  [{ ...baseTelemetry, cacheHits: ['0'] }, /cache hit segment must be a number/],
  [{ ...baseTelemetry, cacheHits: [{}] }, /cache hit segment must be a number/],
  [{ ...baseTelemetry, cacheHits: [0.5] }, /cache hit segment 0\.5 is outside 0\.\.0/],
  [{ ...baseTelemetry, cacheArtifacts: {} }, /cacheArtifacts must be an array when present/],
  [{ ...baseTelemetry, cacheArtifacts: [null] }, /cacheArtifacts\[0\] must be a non-null object/],
  [{ ...baseTelemetry, cacheArtifacts: [[]] }, /cacheArtifacts\[0\] must be a non-null object/],
  [{
    ...baseTelemetry,
    cacheArtifacts: [{ segmentIndex: '0', sha256: 'a'.repeat(64) }],
  }, /cacheArtifacts\[0\]\.segmentIndex must be a number/],
  [{
    ...baseTelemetry,
    cacheArtifacts: [{ segmentIndex: 0, sha256: Symbol('bad-sha') }],
  }, /cacheArtifacts\[0\]\.sha256 must be a string/],
];

function hostileThrownValue(onCoercion: () => void): object {
  return {
    [Symbol.toPrimitive]() {
      onCoercion();
      throw new Error('must not coerce telemetry failure');
    },
    valueOf() {
      onCoercion();
      throw new Error('must not valueOf telemetry failure');
    },
    toString() {
      onCoercion();
      throw new Error('must not stringify telemetry failure');
    },
  };
}

describe('AdaptiveChunkDispatcher telemetry container validation', () => {
  it.each(malformedTelemetryCases)(
    'rejects malformed telemetry before registration state is created',
    (malformedTelemetry, expectedError) => {
      const dispatcher = new AdaptiveChunkDispatcher({
        segments: makeSegments(1),
      });

      expect(() => dispatcher.registerWorker({
        id: 'malformed-registration-worker',
        tier: WorkerTier.TIER_2,
        telemetry: malformedTelemetry as WorkerTelemetry,
      })).toThrow(expectedError);

      expect(() => dispatcher.run('after-malformed-registration')).toThrow(
        /No eligible adaptive worker/,
      );
    },
  );

  it.each(malformedTelemetryCases)(
    'preserves last-known-good worker state after a malformed heartbeat',
    (malformedTelemetry, expectedError) => {
      const dispatcher = new AdaptiveChunkDispatcher({
        segments: makeSegments(1),
      });
      const worker = workerId('stable-shape-worker');
      dispatcher.registerWorker({
        id: worker,
        tier: WorkerTier.TIER_2,
        telemetry: baseTelemetry,
      });

      expect(() => dispatcher.updateHeartbeat(
        worker,
        malformedTelemetry as WorkerTelemetry,
      )).toThrow(expectedError);

      const report = dispatcher.run('after-malformed-heartbeat');
      expect(report.assignments).toHaveLength(1);
      expect(report.assignments[0]).toMatchObject({
        workerId: worker,
        cacheHit: true,
        loadReadings: {
          gpuBusyRatio: 0.01,
          cpuBusyRatio: 0.01,
        },
      });
      expect(Number.isFinite(report.assignments[0].scoreInputs.total)).toBe(true);
    },
  );

  it('reads telemetry collections and cache-artifact identity fields exactly once', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(1),
    });
    let cacheHitsReads = 0;
    let cacheArtifactsReads = 0;
    let segmentIndexReads = 0;
    let sha256Reads = 0;

    const identity = Object.defineProperties({}, {
      segmentIndex: {
        enumerable: true,
        get: () => {
          segmentIndexReads++;
          return segmentIndexReads === 1 ? 0 : 'altered';
        },
      },
      sha256: {
        enumerable: true,
        get: () => {
          sha256Reads++;
          return sha256Reads === 1 ? 'a'.repeat(64) : 42;
        },
      },
    }) as CachedArtifactIdentity;

    const telemetry = {
      ...baseTelemetry,
      get cacheHits() {
        cacheHitsReads++;
        return cacheHitsReads === 1 ? [0] : ['altered'];
      },
      get cacheArtifacts() {
        cacheArtifactsReads++;
        return cacheArtifactsReads === 1 ? [identity] : 'altered';
      },
    } as unknown as WorkerTelemetry;

    dispatcher.registerWorker({
      id: 'single-read-telemetry-worker',
      tier: WorkerTier.TIER_2,
      telemetry,
    });

    expect(cacheHitsReads).toBe(1);
    expect(cacheArtifactsReads).toBe(1);
    expect(segmentIndexReads).toBe(1);
    expect(sha256Reads).toBe(1);
    expect(dispatcher.run('single-read-telemetry').assignments[0].cacheHit).toBe(true);
  });

  it('detaches cache-artifact membership before reading identity fields', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(2),
    });
    const secondIdentity: CachedArtifactIdentity = {
      segmentIndex: 1,
      sha256: 'b'.repeat(64),
    };
    const cacheArtifacts: CachedArtifactIdentity[] = [];
    const firstIdentity = Object.defineProperties({}, {
      segmentIndex: {
        enumerable: true,
        get: () => {
          cacheArtifacts[1] = {
            segmentIndex: 'altered' as unknown as number,
            sha256: 'altered',
          };
          return 0;
        },
      },
      sha256: {
        enumerable: true,
        value: 'a'.repeat(64),
      },
    }) as CachedArtifactIdentity;
    cacheArtifacts.push(firstIdentity, secondIdentity);

    dispatcher.registerWorker({
      id: 'detached-cache-artifact-membership-worker',
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...baseTelemetry,
        cacheHits: [0, 1],
        cacheArtifacts,
      },
    });

    const report = dispatcher.run('detached-cache-artifact-membership');
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0].cacheHit).toBe(true);
  });

  it('detaches cache hits before scalar telemetry getters can mutate caller state', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(1),
    });
    const cacheHits = [0];
    const telemetry = {
      ...baseTelemetry,
      cacheHits,
      get uptimeMs() {
        cacheHits[0] = 99;
        return baseTelemetry.uptimeMs;
      },
    } as WorkerTelemetry;

    dispatcher.registerWorker({
      id: 'detached-cache-hit-membership-worker',
      tier: WorkerTier.TIER_2,
      telemetry,
    });

    expect(dispatcher.run('detached-cache-hit-membership').assignments[0].cacheHit).toBe(true);
  });

  it('fails closed on revoked telemetry and nested runtime containers', () => {
    const dispatcher = new AdaptiveChunkDispatcher({ segments: makeSegments(1) });

    const telemetry = Proxy.revocable({ ...baseTelemetry }, {});
    telemetry.revoke();
    expect(() => dispatcher.registerWorker({
      id: 'revoked-telemetry-worker',
      tier: WorkerTier.TIER_2,
      telemetry: telemetry.proxy as WorkerTelemetry,
    })).toThrow(/worker telemetry must be a non-null object/);

    const cacheHits = Proxy.revocable([0], {});
    cacheHits.revoke();
    expect(() => dispatcher.registerWorker({
      id: 'revoked-cache-hits-worker',
      tier: WorkerTier.TIER_2,
      telemetry: { ...baseTelemetry, cacheHits: cacheHits.proxy },
    })).toThrow(/worker telemetry cacheHits must be an array/);

    const cacheArtifacts = Proxy.revocable([] as CachedArtifactIdentity[], {});
    cacheArtifacts.revoke();
    expect(() => dispatcher.registerWorker({
      id: 'revoked-cache-artifacts-worker',
      tier: WorkerTier.TIER_2,
      telemetry: { ...baseTelemetry, cacheArtifacts: cacheArtifacts.proxy },
    })).toThrow(/worker telemetry cacheArtifacts must be an array when present/);

    const identity = Proxy.revocable({
      segmentIndex: 0,
      sha256: 'a'.repeat(64),
    }, {});
    identity.revoke();
    expect(() => dispatcher.registerWorker({
      id: 'revoked-cache-artifact-identity-worker',
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...baseTelemetry,
        cacheArtifacts: [identity.proxy as CachedArtifactIdentity],
      },
    })).toThrow(/worker telemetry cacheArtifacts\[0\] must be a non-null object/);
  });

  it.each([
    ['cacheHits', /worker telemetry cacheHits could not be read/],
    ['cacheArtifacts', /worker telemetry cacheArtifacts could not be read/],
    ['uptimeMs', /worker telemetry uptimeMs could not be read/],
    ['vramFreeMB', /worker telemetry vramFreeMB could not be read/],
    ['gpuBusyRatio', /worker telemetry gpuBusyRatio could not be read/],
    ['cpuBusyRatio', /worker telemetry cpuBusyRatio could not be read/],
    ['tokensPerSecond', /worker telemetry tokensPerSecond could not be read/],
    ['checkpointBytesPerSecond', /worker telemetry checkpointBytesPerSecond could not be read/],
    ['failureRate', /worker telemetry failureRate could not be read/],
    ['heartbeatJitterMs', /worker telemetry heartbeatJitterMs could not be read/],
  ] as const)(
    'bounds a throwing telemetry %s accessor without coercion',
    (field, expectedError) => {
      const dispatcher = new AdaptiveChunkDispatcher({ segments: makeSegments(1) });
      let coercions = 0;
      const thrown = hostileThrownValue(() => { coercions += 1; });
      const telemetry = { ...baseTelemetry } as WorkerTelemetry;
      Object.defineProperty(telemetry, field, {
        configurable: true,
        get() {
          throw thrown;
        },
      });

      expect(() => dispatcher.registerWorker({
        id: `throwing-${field}-worker`,
        tier: WorkerTier.TIER_2,
        telemetry,
      })).toThrow(expectedError);
      expect(coercions).toBe(0);
    },
  );

  it.each([
    ['segmentIndex', /worker telemetry cacheArtifacts\[0\]\.segmentIndex could not be read/],
    ['sha256', /worker telemetry cacheArtifacts\[0\]\.sha256 could not be read/],
  ] as const)(
    'bounds a throwing cache-artifact %s accessor without coercion',
    (field, expectedError) => {
      const dispatcher = new AdaptiveChunkDispatcher({ segments: makeSegments(1) });
      let coercions = 0;
      const thrown = hostileThrownValue(() => { coercions += 1; });
      const identity: Record<string, unknown> = {
        segmentIndex: 0,
        sha256: 'a'.repeat(64),
      };
      Object.defineProperty(identity, field, {
        configurable: true,
        get() {
          throw thrown;
        },
      });

      expect(() => dispatcher.registerWorker({
        id: `throwing-cache-artifact-${field}-worker`,
        tier: WorkerTier.TIER_2,
        telemetry: {
          ...baseTelemetry,
          cacheArtifacts: [identity as unknown as CachedArtifactIdentity],
        },
      })).toThrow(expectedError);
      expect(coercions).toBe(0);
    },
  );

  it('preserves last-known-good state after revoked heartbeat and re-registration telemetry', () => {
    const dispatcher = new AdaptiveChunkDispatcher({ segments: makeSegments(1) });
    const worker = workerId('stable-revoked-telemetry-worker');
    dispatcher.registerWorker({ id: worker, tier: WorkerTier.TIER_2, telemetry: baseTelemetry });

    for (const operation of ['heartbeat', 'registration'] as const) {
      const cacheHits = Proxy.revocable([0], {});
      cacheHits.revoke();
      const rejectedTelemetry = {
        ...baseTelemetry,
        cacheHits: cacheHits.proxy,
        gpuBusyRatio: 1,
        cpuBusyRatio: 1,
      } as WorkerTelemetry;

      if (operation === 'heartbeat') {
        expect(() => dispatcher.updateHeartbeat(worker, rejectedTelemetry)).toThrow(
          /worker telemetry cacheHits must be an array/,
        );
      } else {
        expect(() => dispatcher.registerWorker({
          id: worker,
          tier: WorkerTier.TIER_3,
          telemetry: rejectedTelemetry,
        })).toThrow(/worker telemetry cacheHits must be an array/);
      }

      const report = dispatcher.run(`after-revoked-${operation}`);
      expect(report.assignments[0]).toMatchObject({
        workerId: worker,
        tier: WorkerTier.TIER_2,
        cacheHit: true,
        loadReadings: {
          gpuBusyRatio: baseTelemetry.gpuBusyRatio,
          cpuBusyRatio: baseTelemetry.cpuBusyRatio,
        },
      });
    }
  });
});
