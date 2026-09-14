import { describe, expect, it } from 'vitest';
import {
  AllowlistedPrototypeTransport,
  SimulatedPrototypeWorker,
  TwoWorkerPrototypeRunner,
} from '../src/two-worker-prototype.js';

function worker(id: string, segmentIndex: 0 | 1): SimulatedPrototypeWorker {
  return new SimulatedPrototypeWorker({
    id,
    segmentIndex,
    webgpuAdapter: `adapter-${id}`,
    vramMB: 4096,
    failFirstRun: false,
  });
}

describe('TwoWorkerPrototypeRunner constructor dependency envelope', () => {
  it.each([
    null,
    42,
    'runner',
    [],
    Symbol('runner-options'),
    () => undefined,
  ])('rejects malformed top-level constructor options', (options) => {
    expect(() => new TwoWorkerPrototypeRunner(options as never)).toThrow(
      /runner options must be a non-null object when provided/,
    );
  });

  it('preserves undefined as the default construction path', async () => {
    const runner = new TwoWorkerPrototypeRunner(undefined);
    const report = await runner.run({ prompt: 'default construction remains valid' });

    expect(report.requestId).toBe('proto-1');
    expect(report.matchesReference).toBe(true);
  });

  it.each([
    [{ transport: {} }, /transport must be an AllowlistedPrototypeTransport/],
    [{ segment0: {} }, /segment0 must be a SimulatedPrototypeWorker/],
    [{ segment1Primary: {} }, /segment1Primary must be a SimulatedPrototypeWorker/],
    [{ segment1Standby: {} }, /segment1Standby must be a SimulatedPrototypeWorker/],
  ] as const)('rejects malformed injected dependencies', (options, error) => {
    expect(() => new TwoWorkerPrototypeRunner(options as never)).toThrow(error);
  });

  it('rejects real simulated workers injected into the wrong fixed-topology roles', () => {
    expect(() => new TwoWorkerPrototypeRunner({
      segment0: worker('wrong-seg0', 1),
    })).toThrow(/segment0 must target segment 0/);

    expect(() => new TwoWorkerPrototypeRunner({
      segment1Primary: worker('wrong-primary', 0),
    })).toThrow(/segment1Primary must target segment 1/);

    expect(() => new TwoWorkerPrototypeRunner({
      segment1Standby: worker('wrong-standby', 0),
    })).toThrow(/segment1Standby must target segment 1/);
  });

  it('keeps accepted worker identity and role immutable after runner construction', async () => {
    const segment0 = worker('stable-seg0', 0);
    const segment1Primary = worker('stable-primary', 1);
    const segment1Standby = worker('stable-standby', 1);
    const runner = new TwoWorkerPrototypeRunner({
      segment0,
      segment1Primary,
      segment1Standby,
    });

    expect(Reflect.set(segment0, 'segmentIndex', 1)).toBe(false);
    expect(Reflect.set(segment1Primary, 'id', 'tampered-primary')).toBe(false);
    expect(segment0.segmentIndex).toBe(0);
    expect(segment1Primary.id).toBe('stable-primary');

    const report = await runner.run({ prompt: 'identity remains stable' });
    expect(report.matchesReference).toBe(true);
    expect(report.segments.map((segment) => segment.workerId)).toEqual([
      'stable-seg0',
      'stable-primary',
    ]);
  });

  it('captures injected dependency accessors once before retaining runner state', async () => {
    const transport = new AllowlistedPrototypeTransport([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);
    const segment0 = worker('owned-seg0', 0);
    const segment1Primary = worker('owned-seg1-primary', 1);
    const segment1Standby = worker('owned-seg1-standby', 1);
    const reads = {
      transport: 0,
      segment0: 0,
      segment1Primary: 0,
      segment1Standby: 0,
    };
    const options = Object.defineProperties({}, {
      transport: {
        enumerable: true,
        get() {
          reads.transport++;
          return reads.transport === 1 ? transport : {};
        },
      },
      segment0: {
        enumerable: true,
        get() {
          reads.segment0++;
          return reads.segment0 === 1 ? segment0 : {};
        },
      },
      segment1Primary: {
        enumerable: true,
        get() {
          reads.segment1Primary++;
          return reads.segment1Primary === 1 ? segment1Primary : {};
        },
      },
      segment1Standby: {
        enumerable: true,
        get() {
          reads.segment1Standby++;
          return reads.segment1Standby === 1 ? segment1Standby : {};
        },
      },
    });

    const runner = new TwoWorkerPrototypeRunner(options as never);

    expect(reads).toEqual({
      transport: 1,
      segment0: 1,
      segment1Primary: 1,
      segment1Standby: 1,
    });

    const report = await runner.run({ prompt: 'owned dependency envelope' });
    expect(report.matchesReference).toBe(true);
    expect(report.segments.map((segment) => segment.workerId)).toEqual([
      'owned-seg0',
      'owned-seg1-primary',
    ]);
    expect(transport.connectionCount).toBeGreaterThan(0);
    expect(reads).toEqual({
      transport: 1,
      segment0: 1,
      segment1Primary: 1,
      segment1Standby: 1,
    });
  });

  it('keeps valid custom dependency injection behavior', async () => {
    const transport = new AllowlistedPrototypeTransport([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);
    const runner = new TwoWorkerPrototypeRunner({
      transport,
      segment0: worker('custom-seg0', 0),
      segment1Primary: worker('custom-seg1-primary', 1),
      segment1Standby: worker('custom-seg1-standby', 1),
    });

    const report = await runner.run({ prompt: 'custom dependency envelope' });

    expect(report.matchesReference).toBe(true);
    expect(report.segments.map((segment) => segment.workerId)).toEqual([
      'custom-seg0',
      'custom-seg1-primary',
    ]);
    expect(transport.connectionCount).toBeGreaterThan(0);
  });
});
