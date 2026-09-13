import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../src/durable-repository.js';
import type { ResultIdentity } from '../src/durable-types.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import { LeaseManager } from '../src/lease-manager.js';
import { workerId } from '../src/types.js';

const MANIFEST_DIGEST = 'd'.repeat(64);

class CountingLeaseRepository extends InMemoryRepository {
  activeLeaseReads = 0;
  leaseDeletes = 0;

  override getActiveLease(
    ...args: Parameters<InMemoryRepository['getActiveLease']>
  ): ReturnType<InMemoryRepository['getActiveLease']> {
    this.activeLeaseReads += 1;
    return super.getActiveLease(...args);
  }

  override deleteLease(
    ...args: Parameters<InMemoryRepository['deleteLease']>
  ): ReturnType<InMemoryRepository['deleteLease']> {
    this.leaseDeletes += 1;
    return super.deleteLease(...args);
  }

  resetCounters(): void {
    this.activeLeaseReads = 0;
    this.leaseDeletes = 0;
  }
}

function activateLease(manager: LeaseManager): ResultIdentity {
  const identity: ResultIdentity = {
    requestId: generateRequestId(),
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('worker-1'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: 2,
  };
  manager.setActive(
    manager.issue({
      ...identity,
      modelManifestDigest: MANIFEST_DIGEST,
      issuedAt: 1_000,
      expiresAt: 10_000,
    }),
  );
  return identity;
}

function expectProtocolViolation(run: () => unknown, message: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UnzenError);
  expect((thrown as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
  expect((thrown as Error).message).toBe(message);
}

const resultOperations = [
  {
    name: 'match',
    run: (manager: LeaseManager, identity: unknown, now: unknown) =>
      manager.match(identity as never, now as never),
  },
  {
    name: 'reclaim',
    run: (manager: LeaseManager, identity: unknown, now: unknown) =>
      manager.reclaim(identity as never, now as never),
  },
] as const;

const malformedContainers: readonly unknown[] = [
  null,
  undefined,
  42,
  true,
  'identity',
  [],
  Symbol('identity'),
  () => undefined,
];

const malformedStrings: readonly unknown[] = [
  null,
  undefined,
  42,
  true,
  [],
  {},
  Symbol('field'),
  () => undefined,
  '',
  '   ',
];

describe('LeaseManager result identity runtime envelope', () => {
  it.each(resultOperations)(
    '$name rejects malformed top-level identity before lease lookup or deletion',
    ({ run }) => {
      for (const malformed of malformedContainers) {
        const repository = new CountingLeaseRepository();
        const manager = new LeaseManager(repository);
        activateLease(manager);
        repository.resetCounters();

        expectProtocolViolation(
          () => run(manager, malformed, 5_000),
          'lease result identity must be a non-null object',
        );

        expect(repository.activeLeaseReads).toBe(0);
        expect(repository.leaseDeletes).toBe(0);
      }
    },
  );

  it.each(['requestId', 'attemptId', 'leaseId', 'workerId', 'workerGeneration'] as const)(
    'rejects malformed %s before durable lease lookup',
    (field) => {
      for (const malformed of malformedStrings) {
        const repository = new CountingLeaseRepository();
        const manager = new LeaseManager(repository);
        const identity = activateLease(manager);
        repository.resetCounters();

        expectProtocolViolation(
          () => manager.match({ ...identity, [field]: malformed } as never, 5_000),
          `lease result identity ${field} must be a non-empty string`,
        );

        expect(repository.activeLeaseReads).toBe(0);
        expect(repository.leaseDeletes).toBe(0);
      }
    },
  );

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '2',
    Symbol('segment'),
    {},
  ])('rejects malformed segmentIndex %p before durable lease lookup', (malformed) => {
    const repository = new CountingLeaseRepository();
    const manager = new LeaseManager(repository);
    const identity = activateLease(manager);
    repository.resetCounters();

    expectProtocolViolation(
      () => manager.match({ ...identity, segmentIndex: malformed } as never, 5_000),
      'lease result identity segmentIndex must be a non-negative safe integer',
    );

    expect(repository.activeLeaseReads).toBe(0);
    expect(repository.leaseDeletes).toBe(0);
  });

  it.each([
    null,
    undefined,
    '5000',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Symbol('now'),
    {},
  ])('rejects malformed match clock %p before durable lease lookup', (malformed) => {
    const repository = new CountingLeaseRepository();
    const manager = new LeaseManager(repository);
    const identity = activateLease(manager);
    repository.resetCounters();

    expectProtocolViolation(
      () => manager.match(identity, malformed as never),
      'lease match now must be a finite number',
    );

    expect(repository.activeLeaseReads).toBe(0);
    expect(repository.leaseDeletes).toBe(0);
  });

  it('preserves valid exact match and compare-and-delete reclaim semantics', () => {
    const repository = new CountingLeaseRepository();
    const manager = new LeaseManager(repository);
    const identity = activateLease(manager);

    expect(manager.match(identity, 5_000)).toEqual({ ok: true });
    expect(manager.reclaim(identity, 5_000)).toEqual({ ok: true });
    expect(repository.leaseDeletes).toBe(1);
    expect(manager.match(identity, 5_000)).toEqual({ ok: false, reason: 'no-active-lease' });
  });

  it('preserves valid expiry and mismatch reasons without deleting the active lease', () => {
    const repository = new CountingLeaseRepository();
    const manager = new LeaseManager(repository);
    const identity = activateLease(manager);

    expect(manager.match(identity, 10_001)).toEqual({ ok: false, reason: 'lease-expired' });
    expect(manager.reclaim({ ...identity, attemptId: generateAttemptId() }, 5_000)).toEqual({
      ok: false,
      reason: 'attempt-mismatch',
    });
    expect(repository.leaseDeletes).toBe(0);
  });
});
