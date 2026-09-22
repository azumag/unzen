import { describe, expect, it } from 'vitest';
import {
  AllowlistedPrototypeTransport,
  SimulatedPrototypeWorker,
  TwoWorkerPrototypeRunner,
  type PrototypeWorkerOptions,
  type TwoWorkerPrototypeOptions,
} from '../src/two-worker-prototype.js';

function makeRevokedProxy<T extends object>(target: T): T {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

function makeCoercionTrap(): object {
  return {
    [Symbol.toPrimitive]: () => {
      throw new Error('coercion must not run');
    },
    valueOf: () => {
      throw new Error('valueOf must not run');
    },
    toString: () => {
      throw new Error('toString must not run');
    },
  };
}

describe('two-worker prototype runtime ownership boundary', () => {
  it('fails closed when the transport allowlist is a revoked array proxy', () => {
    const revoked = makeRevokedProxy([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);

    expect(() => new AllowlistedPrototypeTransport(revoked)).toThrow(
      'prototype allowedOrigins must be an array',
    );
  });

  it('does not call caller-owned map or iterator methods while snapshotting the allowlist', () => {
    let mapReads = 0;
    let iteratorReads = 0;
    const allowlist = new Proxy([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ], {
      get(target, property, receiver) {
        if (property === 'map') {
          mapReads++;
          throw new Error('map must not be read');
        }
        if (property === Symbol.iterator) {
          iteratorReads++;
          throw new Error('iterator must not be read');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const transport = new AllowlistedPrototypeTransport(allowlist);

    expect(transport.allowlist).toEqual([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);
    expect(mapReads).toBe(0);
    expect(iteratorReads).toBe(0);
  });

  it('fails closed on throwing allowlist length and index reads', () => {
    const lengthFailure = new Proxy(['https://coordinator.unzen.local'], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw makeCoercionTrap();
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => new AllowlistedPrototypeTransport(lengthFailure)).toThrow(
      'prototype allowedOrigins length could not be read',
    );

    const indexFailure = new Proxy(['https://coordinator.unzen.local'], {
      get(target, property, receiver) {
        if (property === '0') {
          throw makeCoercionTrap();
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => new AllowlistedPrototypeTransport(indexFailure)).toThrow(
      'prototype allowlist URL at index 0 could not be read',
    );
  });

  it('bounds hostile worker option containers and accessor failures without coercion', () => {
    const revoked = makeRevokedProxy({
      id: 'worker-a',
      segmentIndex: 0 as const,
      webgpuAdapter: 'adapter-a',
      vramMB: 4096,
    });
    expect(() => new SimulatedPrototypeWorker(revoked)).toThrow(
      'prototype worker id could not be read',
    );

    const options = {
      id: 'worker-b',
      segmentIndex: 0 as const,
      webgpuAdapter: 'adapter-b',
      vramMB: 4096,
    } as PrototypeWorkerOptions;
    Object.defineProperty(options, 'webgpuAdapter', {
      get: () => {
        throw makeCoercionTrap();
      },
    });
    expect(() => new SimulatedPrototypeWorker(options)).toThrow(
      'prototype worker webgpuAdapter could not be read',
    );
  });

  it('bounds hostile dependency access and instanceof prototype walks', () => {
    const dependencies = {} as Record<string, unknown>;
    Object.defineProperty(dependencies, 'transport', {
      get: () => {
        throw makeCoercionTrap();
      },
    });
    expect(() => new TwoWorkerPrototypeRunner(dependencies as never)).toThrow(
      'two-worker prototype runner transport could not be read',
    );

    const hostileDependency = new Proxy({}, {
      getPrototypeOf() {
        throw makeCoercionTrap();
      },
    });
    expect(() => new TwoWorkerPrototypeRunner({
      transport: hostileDependency as AllowlistedPrototypeTransport,
    })).toThrow(
      'two-worker prototype runner transport must be an AllowlistedPrototypeTransport',
    );
  });

  it('rejects hostile run option reads before transport or request state mutates', async () => {
    const transport = new AllowlistedPrototypeTransport([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);
    const runner = new TwoWorkerPrototypeRunner({ transport });
    const options = { prompt: 'ignored' } as TwoWorkerPrototypeOptions;
    Object.defineProperty(options, 'prompt', {
      get: () => {
        throw makeCoercionTrap();
      },
    });

    await expect(runner.run(options)).rejects.toThrow(
      'two-worker prototype prompt could not be read',
    );
    expect(transport.connectionCount).toBe(0);

    const report = await runner.run({ prompt: 'valid after hostile options' });
    expect(report.requestId).toBe('proto-1');
  });

  it('fails closed on revoked execution and checkpoint containers', async () => {
    const worker0 = new SimulatedPrototypeWorker({
      id: 'segment-0',
      segmentIndex: 0,
      webgpuAdapter: 'adapter-a',
      vramMB: 4096,
    });
    const revokedInput = makeRevokedProxy({
      requestId: 'request-1',
      prompt: 'prompt',
      coordinatorUrl: 'https://coordinator.unzen.local',
      cdnUrl: 'https://cdn.unzen.local',
      transport: new AllowlistedPrototypeTransport([
        'https://coordinator.unzen.local',
        'https://cdn.unzen.local',
      ]),
    });
    await expect(worker0.execute(revokedInput as never)).rejects.toThrow(
      'prototype worker requestId could not be read',
    );

    const worker1 = new SimulatedPrototypeWorker({
      id: 'segment-1',
      segmentIndex: 1,
      webgpuAdapter: 'adapter-b',
      vramMB: 4096,
    });
    const transport = new AllowlistedPrototypeTransport([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);
    const checkpoint = makeRevokedProxy({ hiddenStates: new Uint8Array([1]) });
    await expect(worker1.execute({
      requestId: 'request-2',
      prompt: 'prompt',
      coordinatorUrl: 'https://coordinator.unzen.local',
      cdnUrl: 'https://cdn.unzen.local',
      transport,
      checkpoint,
    } as never)).rejects.toThrow(
      'prototype segment 1 checkpoint hiddenStates could not be read',
    );
    expect(transport.connectionCount).toBe(0);
  });

  it('preserves valid custom dependencies, retry, checkpoint relay, and warm-cache behavior', async () => {
    const transport = new AllowlistedPrototypeTransport([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);
    const segment0 = new SimulatedPrototypeWorker({
      id: 'custom-segment-0',
      segmentIndex: 0,
      webgpuAdapter: 'adapter-a',
      vramMB: 4096,
    });
    const segment1Primary = new SimulatedPrototypeWorker({
      id: 'custom-segment-1-primary',
      segmentIndex: 1,
      webgpuAdapter: 'adapter-b',
      vramMB: 4096,
      failFirstRun: true,
    });
    const segment1Standby = new SimulatedPrototypeWorker({
      id: 'custom-segment-1-standby',
      segmentIndex: 1,
      webgpuAdapter: 'adapter-c',
      vramMB: 4096,
    });
    const runner = new TwoWorkerPrototypeRunner({
      transport,
      segment0,
      segment1Primary,
      segment1Standby,
    });

    const first = await runner.run({ prompt: 'runtime boundary' });
    const second = await runner.run({ prompt: 'runtime boundary' });

    expect(first.matchesReference).toBe(true);
    expect(first.segments[1]?.retryCount).toBe(1);
    expect(first.segments[1]?.workerId).toBe('custom-segment-1-standby');
    expect(first.checkpointRelayBytes).toBeGreaterThan(0);
    expect(second.segments.map((segment) => segment.cacheHit)).toEqual([true, false]);
    expect(second.matchesReference).toBe(true);
  });
});
