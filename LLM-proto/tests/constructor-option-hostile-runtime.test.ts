import { describe, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import { Coordinator, type CoordinatorOptions } from '../src/coordinator.js';
import {
  DurableCoordinator,
  type DurableCoordinatorOptions,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import {
  Pipeline,
  type PipelineOptions,
  type SegmentExecutor,
} from '../src/pipeline.js';
import {
  SpanPipeline,
  type SpanExecutor,
  type SpanPipelineOptions,
} from '../src/span-pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';

const segmentExecutor: SegmentExecutor = {
  execute: vi.fn(async () => {
    throw new Error('executor must not run during constructor option preflight');
  }),
};

const spanExecutor: SpanExecutor = {
  execute: vi.fn(async () => {
    throw new Error('executor must not run during constructor option preflight');
  }),
};

const durableExecutor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('executor must not run during constructor option preflight');
  },
};

function constructCoordinator(options: unknown): unknown {
  return new Coordinator(
    segmentExecutor,
    createFixtureModelManifest({ totalSegments: 1 }),
    options as Partial<CoordinatorOptions>,
  );
}

function constructDurableCoordinator(options: unknown): unknown {
  return new DurableCoordinator(
    durableExecutor,
    createFixtureModelManifest({ totalSegments: 1 }),
    options as Partial<DurableCoordinatorOptions>,
  );
}

function constructPipeline(options: unknown): unknown {
  return new Pipeline(
    [],
    new WorkerPool(),
    new CheckpointStore(),
    segmentExecutor,
    options as Partial<PipelineOptions>,
  );
}

function constructSpanPipeline(options: unknown): unknown {
  return new SpanPipeline(
    [],
    new WorkerPool(),
    new CheckpointStore(),
    spanExecutor,
    options as Partial<SpanPipelineOptions>,
  );
}

interface ConstructorCase {
  readonly name: string;
  readonly field: string;
  readonly construct: (options: unknown) => unknown;
  readonly invalidRootPattern: RegExp;
  readonly inspectedPattern: RegExp;
  readonly readPattern: RegExp;
}

const cases: readonly ConstructorCase[] = [
  {
    name: 'Coordinator',
    field: 'heartbeatIntervalMs',
    construct: constructCoordinator,
    invalidRootPattern: /Coordinator options must be a non-null, non-array object/,
    inspectedPattern: /Coordinator option heartbeatIntervalMs could not be inspected/,
    readPattern: /Coordinator option heartbeatIntervalMs could not be read/,
  },
  {
    name: 'DurableCoordinator',
    field: 'heartbeatIntervalMs',
    construct: constructDurableCoordinator,
    invalidRootPattern: /DurableCoordinator options must be a non-null, non-array object/,
    inspectedPattern: /DurableCoordinator option heartbeatIntervalMs could not be inspected/,
    readPattern: /DurableCoordinator option heartbeatIntervalMs could not be read/,
  },
  {
    name: 'Pipeline',
    field: 'maxRetries',
    construct: constructPipeline,
    invalidRootPattern: /Pipeline options must be a non-null, non-array object/,
    inspectedPattern: /Pipeline option maxRetries could not be inspected/,
    readPattern: /Pipeline option maxRetries could not be read/,
  },
  {
    name: 'SpanPipeline',
    field: 'maxRetries',
    construct: constructSpanPipeline,
    invalidRootPattern: /SpanPipeline options must be a non-null, non-array object/,
    inspectedPattern: /SpanPipeline option maxRetries could not be inspected/,
    readPattern: /SpanPipeline option maxRetries could not be read/,
  },
];

function hostileThrownValue() {
  let coercions = 0;
  const value = {
    toString() {
      coercions += 1;
      throw new Error('hostile toString must not run');
    },
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error('hostile Symbol.toPrimitive must not run');
    },
  };
  return {
    value,
    coercions: () => coercions,
  };
}

describe.each(cases)('$name constructor option hostile runtime boundary', ({
  construct,
  field,
  invalidRootPattern,
  inspectedPattern,
  readPattern,
}) => {
  it('fails closed for a revoked option root', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => construct(proxy)).toThrow(invalidRootPattern);
  });

  it('fails closed when declared-field descriptor inspection throws without coercing the thrown value', () => {
    const hostile = hostileThrownValue();
    const options = new Proxy({}, {
      getOwnPropertyDescriptor(_target, key) {
        if (key === field) throw hostile.value;
        return undefined;
      },
      ownKeys() {
        throw new Error('constructor option resolution must not enumerate caller options');
      },
    });

    expect(() => construct(options)).toThrow(inspectedPattern);
    expect(hostile.coercions()).toBe(0);
  });

  it('fails closed when a declared own-enumerable getter throws without coercing the thrown value', () => {
    const hostile = hostileThrownValue();
    const options = Object.defineProperty({}, field, {
      enumerable: true,
      configurable: true,
      get() {
        throw hostile.value;
      },
    });

    expect(() => construct(options)).toThrow(readPattern);
    expect(hostile.coercions()).toBe(0);
  });
});

describe('SpanPipeline constructor option failure ordering', () => {
  it('does not touch the residency dependency after an earlier numeric option getter fails', () => {
    let residencyReads = 0;
    const hostile = hostileThrownValue();
    const options = Object.defineProperties({}, {
      maxRetries: {
        enumerable: true,
        get() {
          throw hostile.value;
        },
      },
      artifactResidencyLedger: {
        enumerable: true,
        get() {
          residencyReads += 1;
          throw new Error('residency dependency must not be read after an earlier option failure');
        },
      },
    });

    expect(() => constructSpanPipeline(options)).toThrow(
      /SpanPipeline option maxRetries could not be read/,
    );
    expect(residencyReads).toBe(0);
    expect(hostile.coercions()).toBe(0);
  });
});
