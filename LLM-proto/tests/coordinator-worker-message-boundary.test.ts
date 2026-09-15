import { describe, expect, it, vi } from 'vitest';
import { Coordinator } from '../src/coordinator.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import type { SegmentExecutor } from '../src/pipeline.js';
import { WorkerTier } from '../src/types.js';

function createCoordinator(): Coordinator {
  const executor: SegmentExecutor = {
    execute: async () => {
      throw new Error('not used by worker-message boundary tests');
    },
  };

  return new Coordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 2 }),
    {
      totalSegments: 2,
      retryDelayMs: 0,
      allowFixtureManifest: true,
    },
  );
}

describe('Coordinator worker-message runtime boundary', () => {
  it('binds discriminator, payload, and registration fields to one snapshot', () => {
    const coordinator = createCoordinator();
    const reads = new Map<PropertyKey, number>();
    const count = (property: PropertyKey) => {
      reads.set(property, (reads.get(property) ?? 0) + 1);
      return reads.get(property) ?? 0;
    };

    const registration = new Proxy({} as Record<string, unknown>, {
      get(_target, property) {
        const read = count(property);
        switch (property) {
          case 'workerId': return read === 1 ? 'worker-a' : '';
          case 'tier': return read === 1 ? WorkerTier.TIER_2 : 99;
          case 'vramMB': return read === 1 ? 8_192 : Number.NaN;
          default: return undefined;
        }
      },
      ownKeys() {
        throw new Error('registration must not be enumerated');
      },
    });

    let typeReads = 0;
    let payloadReads = 0;
    const message = {
      get type() {
        typeReads++;
        return typeReads === 1 ? 'worker:register' : 'worker:heartbeat';
      },
      get payload() {
        payloadReads++;
        return payloadReads === 1 ? registration : null;
      },
    };

    expect(coordinator.handleWorkerMessage(message)).toBeNull();
    expect(coordinator.workerCount).toBe(1);
    expect(typeReads).toBe(1);
    expect(payloadReads).toBe(1);
    expect(reads.get('workerId')).toBe(1);
    expect(reads.get('tier')).toBe(1);
    expect(reads.get('vramMB')).toBe(1);
  });

  it('rejects malformed registration before WorkerPool mutation', () => {
    const coordinator = createCoordinator();

    expect(() => coordinator.handleWorkerMessage({
      type: 'worker:register',
      payload: { workerId: 'worker-a', tier: WorkerTier.TIER_2, vramMB: 0 },
    })).toThrow(/vramMB/);

    expect(coordinator.workerCount).toBe(0);
  });

  it('validates heartbeat timestamp before liveness mutation or ack', () => {
    const coordinator = createCoordinator();
    coordinator.handleWorkerMessage({
      type: 'worker:register',
      payload: { workerId: 'worker-a', tier: WorkerTier.TIER_2, vramMB: 8_192 },
    });
    const heartbeat = vi.spyOn(coordinator, 'workerHeartbeat');

    expect(() => coordinator.handleWorkerMessage({
      type: 'worker:heartbeat',
      payload: { workerId: 'worker-a', timestamp: Number.NaN },
    })).toThrow(/timestamp/);

    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('captures every declared segment result field once without enumerating payload', () => {
    const coordinator = createCoordinator();
    const values: Record<string, unknown> = {
      requestId: 'request-a',
      segmentIndex: 0,
      workerId: 'worker-a',
      checkpoint: undefined,
      output: { tokens: [1], text: 'ok' },
      processingTimeMs: 12,
    };
    const reads = new Map<PropertyKey, number>();
    const payload = new Proxy({} as Record<string, unknown>, {
      get(_target, property) {
        reads.set(property, (reads.get(property) ?? 0) + 1);
        return values[String(property)];
      },
      ownKeys() {
        throw new Error('segment result payload must not be enumerated');
      },
    });

    expect(coordinator.handleWorkerMessage({ type: 'segment:result', payload })).toBeNull();
    for (const field of [
      'requestId',
      'segmentIndex',
      'workerId',
      'checkpoint',
      'output',
      'processingTimeMs',
    ]) {
      expect(reads.get(field)).toBe(1);
    }
  });

  it('rejects an unknown discriminator without touching payload', () => {
    const coordinator = createCoordinator();
    let payloadReads = 0;
    const message = {
      type: 'worker:surprise',
      get payload() {
        payloadReads++;
        throw new Error('payload must not be read for an unknown type');
      },
    };

    expect(() => coordinator.handleWorkerMessage(message)).toThrow(/unsupported worker message type/);
    expect(payloadReads).toBe(0);
    expect(coordinator.workerCount).toBe(0);
  });
});
