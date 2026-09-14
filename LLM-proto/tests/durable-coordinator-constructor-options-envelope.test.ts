import { describe, expect, it } from 'vitest';
import {
  DurableCoordinator,
  type DurableCoordinatorOptions,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by constructor-envelope tests');
  },
};

function construct(options?: Partial<DurableCoordinatorOptions>) {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    options,
  );
}

describe('DurableCoordinator constructor option envelope', () => {
  it.each([null, [], 'options', 1, () => undefined])(
    'rejects non-object option containers before core construction: %p',
    (options) => {
      expect(() => construct(options as never)).toThrow(
        'DurableCoordinator options must be a non-null, non-array object',
      );
    },
  );

  it('requires allowFixtureManifest to be an actual boolean', () => {
    expect(() => construct({ allowFixtureManifest: 'false' } as never)).toThrow(
      'DurableCoordinator allowFixtureManifest must be a boolean',
    );
    expect(() => construct({ allowFixtureManifest: 1 } as never)).toThrow(
      'DurableCoordinator allowFixtureManifest must be a boolean',
    );
  });

  it('does not let truthy non-boolean fixture flags relax the fixture gate', () => {
    expect(() => construct({ allowFixtureManifest: 'false' } as never)).toThrow(TypeError);
  });

  const finiteControls = [
    'heartbeatIntervalMs',
    'heartbeatTimeoutMs',
    'segmentTimeoutMs',
    'retryDelayMs',
    'leaseTtlMs',
    'checkpointTtlMs',
    'checkpointCleanupIntervalMs',
    'cancelAckDeadlineMs',
    'recoveryOwnershipTtlMs',
    'recoveryOwnershipRenewIntervalMs',
    'recoveryPollIntervalMs',
  ] as const;

  it.each(finiteControls)('validates %s as a non-negative finite number', (field) => {
    expect(() => construct({
      allowFixtureManifest: true,
      [field]: -1,
    } as Partial<DurableCoordinatorOptions>)).toThrow(
      `DurableCoordinator ${field} must be a non-negative finite number`,
    );
  });

  it('rejects non-finite duration controls', () => {
    expect(() => construct({ allowFixtureManifest: true, leaseTtlMs: Number.POSITIVE_INFINITY })).toThrow(
      'DurableCoordinator leaseTtlMs must be a non-negative finite number',
    );
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxCheckpointBytes value %p',
    (maxCheckpointBytes) => {
      expect(() => construct({ allowFixtureManifest: true, maxCheckpointBytes })).toThrow(
        'DurableCoordinator maxCheckpointBytes must be a non-negative safe integer',
      );
    },
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxRetries value %p',
    (maxRetries) => {
      expect(() => construct({ allowFixtureManifest: true, maxRetries })).toThrow(
        'DurableCoordinator maxRetries must be a non-negative safe integer',
      );
    },
  );

  it('preserves explicit zero controls', () => {
    expect(() => construct({
      allowFixtureManifest: true,
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
      maxRetries: 0,
      segmentTimeoutMs: 0,
      retryDelayMs: 0,
      leaseTtlMs: 0,
      checkpointTtlMs: 0,
      checkpointCleanupIntervalMs: 0,
      cancelAckDeadlineMs: 0,
      maxCheckpointBytes: 0,
      recoveryOwnershipTtlMs: 0,
      recoveryOwnershipRenewIntervalMs: 0,
      recoveryPollIntervalMs: 0,
    })).not.toThrow();
  });

  it('captures every declared own-enumerable option once', () => {
    const reads = new Map<keyof DurableCoordinatorOptions, number>();
    const options: Record<string, unknown> = {};

    for (const field of finiteControls) {
      Object.defineProperty(options, field, {
        enumerable: true,
        configurable: true,
        get: () => {
          const count = (reads.get(field) ?? 0) + 1;
          reads.set(field, count);
          return count === 1 ? 0 : Number.NaN;
        },
      });
    }
    Object.defineProperty(options, 'maxCheckpointBytes', {
      enumerable: true,
      configurable: true,
      get: () => {
        const field: keyof DurableCoordinatorOptions = 'maxCheckpointBytes';
        const count = (reads.get(field) ?? 0) + 1;
        reads.set(field, count);
        return count === 1 ? 0 : 0.5;
      },
    });
    Object.defineProperty(options, 'maxRetries', {
      enumerable: true,
      configurable: true,
      get: () => {
        const field: keyof DurableCoordinatorOptions = 'maxRetries';
        const count = (reads.get(field) ?? 0) + 1;
        reads.set(field, count);
        return count === 1 ? 0 : 0.5;
      },
    });
    Object.defineProperty(options, 'allowFixtureManifest', {
      enumerable: true,
      configurable: true,
      get: () => {
        const field: keyof DurableCoordinatorOptions = 'allowFixtureManifest';
        const count = (reads.get(field) ?? 0) + 1;
        reads.set(field, count);
        return count === 1 ? true : false;
      },
    });

    expect(() => construct(options as Partial<DurableCoordinatorOptions>)).not.toThrow();
    for (const field of [...finiteControls, 'maxCheckpointBytes', 'maxRetries', 'allowFixtureManifest'] as const) {
      expect(reads.get(field)).toBe(1);
    }
  });

  it('does not enumerate unknown properties or trigger Proxy ownKeys', () => {
    let unknownReads = 0;
    const target: Record<string, unknown> = { allowFixtureManifest: true };
    Object.defineProperty(target, 'unknownOption', {
      enumerable: true,
      get: () => {
        unknownReads += 1;
        throw new Error('unknown getter must not run');
      },
    });
    const options = new Proxy(target, {
      ownKeys: () => {
        throw new Error('ownKeys must not run');
      },
    });

    expect(() => construct(options as Partial<DurableCoordinatorOptions>)).not.toThrow();
    expect(unknownReads).toBe(0);
  });

  it('ignores inherited declared fields like object spread did', () => {
    const options = Object.create({ allowFixtureManifest: true }) as Partial<DurableCoordinatorOptions>;
    expect(() => construct(options)).toThrow();
  });

  it('ignores non-enumerable declared fields like object spread did', () => {
    const options: Record<string, unknown> = {};
    Object.defineProperty(options, 'allowFixtureManifest', {
      enumerable: false,
      value: true,
    });
    expect(() => construct(options as Partial<DurableCoordinatorOptions>)).toThrow();
  });

  it('rejects invalid options before repository/registry access', () => {
    let repositoryReads = 0;
    const repository = new Proxy({}, {
      get: () => {
        repositoryReads += 1;
        throw new Error('repository must not be touched');
      },
    });

    expect(() => new DurableCoordinator(
      executor,
      createFixtureModelManifest({ totalSegments: 1 }),
      { allowFixtureManifest: 'false' } as never,
      repository as never,
    )).toThrow('DurableCoordinator allowFixtureManifest must be a boolean');
    expect(repositoryReads).toBe(0);
  });
});
