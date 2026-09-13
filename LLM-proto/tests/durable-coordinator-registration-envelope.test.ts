import { describe, expect, it } from 'vitest';
import { DurableCoordinator } from '../src/durable-coordinator.js';
import type { DurableSegmentExecutor } from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { ErrorCode } from '../src/errors.js';
import { workerId, WorkerTier } from '../src/types.js';

const executor: DurableSegmentExecutor = {
  async execute() {
    throw new Error('executor should not run');
  },
};

function coordinator(repo = new InMemoryRepository()): DurableCoordinator {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
    repo,
  );
}

function expectProtocolViolation(action: () => unknown, message: string): void {
  try {
    action();
    throw new Error('expected protocol violation');
  } catch (error) {
    expect(error).toMatchObject({ code: ErrorCode.ProtocolViolation, message });
  }
}

describe('DurableCoordinator worker-registration runtime envelope', () => {
  it.each([null, 1, 'bad', [], Symbol('registration')])(
    'rejects malformed top-level registration %p before field access',
    (registration) => {
      const coord = coordinator();
      expectProtocolViolation(
        () => coord.registerWorker(registration as never, 'connection-a'),
        'worker registration must be a non-null, non-array object',
      );
      expect(coord.workerCount).toBe(0);
    },
  );

  it('rejects malformed worker identity and tier before registration state changes', () => {
    const invalidCases: Array<{
      registration: unknown;
      message: string;
    }> = [
      {
        registration: { workerId: Symbol('worker'), tier: WorkerTier.TIER_3, vramMB: 8192 },
        message: 'worker registration workerId must be a non-empty string',
      },
      {
        registration: { workerId: '   ', tier: WorkerTier.TIER_3, vramMB: 8192 },
        message: 'worker registration workerId must be a non-empty string',
      },
      {
        registration: { workerId: 'worker-a', tier: 'tier-3', vramMB: 8192 },
        message: 'worker registration tier must be TIER_1, TIER_2, or TIER_3',
      },
    ];

    for (const { registration, message } of invalidCases) {
      const coord = coordinator();
      expectProtocolViolation(
        () => coord.registerWorker(registration as never, 'connection-a'),
        message,
      );
      expect(coord.workerCount).toBe(0);
    }
  });

  it.each([
    Symbol('vram'),
    '8192',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -1,
  ])('rejects malformed VRAM %p before the manifest minimum comparison', (vramMB) => {
    const coord = coordinator();
    expectProtocolViolation(
      () => coord.registerWorker({
        workerId: workerId('worker-vram'),
        tier: WorkerTier.TIER_3,
        vramMB,
      } as never, 'connection-a'),
      'worker registration vramMB must be a positive finite number',
    );
    expect(coord.workerCount).toBe(0);
  });

  it.each([null, 1, Symbol('connection'), '', '   '])(
    'rejects malformed connection ID %p before generation mutation',
    (connectionId) => {
      const coord = coordinator();
      expectProtocolViolation(
        () => coord.registerWorker(
          { workerId: workerId('worker-connection'), tier: WorkerTier.TIER_3, vramMB: 8192 },
          connectionId as never,
        ),
        'worker registration connectionId must be a non-empty string',
      );
      expect(coord.workerCount).toBe(0);
    },
  );

  it('does not revoke or replace an existing generation when a reconnect envelope is malformed', () => {
    const coord = coordinator();
    const worker = workerId('stable-worker');
    const created = coord.registerWorker(
      { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8192 },
      'connection-a',
    );
    const before = { ...coord.getWorker(worker)! };

    expectProtocolViolation(
      () => coord.registerWorker({ workerId: worker, tier: WorkerTier.TIER_3, vramMB: Symbol('vram') } as never, 'connection-b'),
      'worker registration vramMB must be a positive finite number',
    );

    expect(coord.workerCount).toBe(1);
    expect(coord.getWorker(worker)).toEqual(before);
    expect(coord.getWorker(worker)?.generation).toBe(created.generation);
  });

  it('preserves manifest minimum-VRAM rejection after runtime validation', () => {
    const coord = coordinator();

    expect(() => coord.registerWorker(
      { workerId: workerId('undersized-worker'), tier: WorkerTier.TIER_3, vramMB: 1024 },
      'connection-a',
    )).toMatchObject({ code: ErrorCode.UnsupportedRequest });
    expect(coord.workerCount).toBe(0);
  });

  it('preserves same-connection refresh and reconnect generation semantics', () => {
    const coord = coordinator();
    const worker = workerId('refresh-worker');

    const created = coord.registerWorker(
      { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8192 },
      'connection-a',
    );
    const updated = coord.registerWorker(
      { workerId: worker, tier: WorkerTier.TIER_2, vramMB: 12288 },
      'connection-a',
    );
    expect(updated).toEqual({ kind: 'updated', generation: created.generation });
    expect(coord.getWorker(worker)).toMatchObject({
      tier: WorkerTier.TIER_2,
      vramMB: 12288,
      generation: created.generation,
      connectionId: 'connection-a',
    });

    const reconnected = coord.registerWorker(
      { workerId: worker, tier: WorkerTier.TIER_2, vramMB: 12288 },
      'connection-b',
    );
    expect(reconnected.kind).toBe('reconnected');
    if (reconnected.kind !== 'reconnected') throw new Error('expected reconnect');
    expect(reconnected.previousGeneration).toBe(created.generation);
    expect(reconnected.generation).not.toBe(created.generation);
    expect(coord.getWorker(worker)).toMatchObject({
      generation: reconnected.generation,
      connectionId: 'connection-b',
    });
    expect(coord.workerCount).toBe(1);
  });
});
