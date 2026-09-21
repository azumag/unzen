import { describe, expect, it } from 'vitest';
import {
  AllowlistedPrototypeTransport,
  SimulatedPrototypeWorker,
} from '../src/two-worker-prototype.js';

const coordinatorUrl = 'https://coordinator.unzen.local';
const cdnUrl = 'https://cdn.unzen.local';

const malformedFieldCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['requestId', { requestId: Symbol('request') }],
  ['prompt', { prompt: 123 }],
  ['coordinatorUrl', { coordinatorUrl: 'not-an-absolute-url' }],
  ['cdnUrl', { cdnUrl: null }],
  ['transport', { transport: {} }],
];

function makeTransport(): AllowlistedPrototypeTransport {
  return new AllowlistedPrototypeTransport([coordinatorUrl, cdnUrl]);
}

function makeSegment0Worker(failFirstRun = false): SimulatedPrototypeWorker {
  return new SimulatedPrototypeWorker({
    id: 'execution-envelope-seg0',
    segmentIndex: 0,
    webgpuAdapter: 'test-adapter',
    vramMB: 2048,
    failFirstRun,
  });
}

function makeSegment1Worker(failFirstRun = false): SimulatedPrototypeWorker {
  return new SimulatedPrototypeWorker({
    id: 'execution-envelope-seg1',
    segmentIndex: 1,
    webgpuAdapter: 'test-adapter',
    vramMB: 2048,
    failFirstRun,
  });
}

describe('SimulatedPrototypeWorker execution envelope', () => {
  it.each([
    null,
    undefined,
    [],
    'input',
    1,
    Symbol('input'),
  ])('rejects malformed top-level input before side effects: %p', async (input) => {
    const worker = makeSegment0Worker(true);
    const transport = makeTransport();

    await expect(worker.execute(input as never)).rejects.toThrow(
      'prototype worker execution input must be a non-null object',
    );
    expect(transport.connectionCount).toBe(0);
    expect(worker.snapshotMetadata().cachedSegments).toEqual([]);

    await expect(worker.execute({
      requestId: 'request-after-malformed-input',
      prompt: 'hello',
      coordinatorUrl,
      cdnUrl,
      transport,
    })).rejects.toThrow('Simulated worker loss');
  });

  it.each(malformedFieldCases)(
    'preflights malformed %s before transport, cache, and fail-once state',
    async (_field, patch) => {
      const worker = makeSegment0Worker(true);
      const transport = makeTransport();
      const input = {
        requestId: 'request-1',
        prompt: 'hello',
        coordinatorUrl,
        cdnUrl,
        transport,
        ...patch,
      };

      await expect(worker.execute(input as never)).rejects.toThrow();
      expect(transport.connectionCount).toBe(0);
      expect(worker.snapshotMetadata().cachedSegments).toEqual([]);

      await expect(worker.execute({
        requestId: 'request-2',
        prompt: 'hello',
        coordinatorUrl,
        cdnUrl,
        transport,
      })).rejects.toThrow('Simulated worker loss');
    },
  );

  it('captures the validated execution transport exactly once', async () => {
    const worker = makeSegment0Worker();
    const transport = makeTransport();
    let transportReads = 0;
    const input = {
      requestId: 'request-owned-transport',
      prompt: 'hello',
      coordinatorUrl,
      cdnUrl,
      get transport() {
        transportReads++;
        return transportReads === 1 ? transport : {};
      },
    };

    const output = await worker.execute(input as never);

    expect(transportReads).toBe(1);
    expect(output.checkpoint?.hiddenStates).toEqual(new TextEncoder().encode('HELLO'));
    expect(transport.connectionCount).toBe(2);
    expect(worker.snapshotMetadata().cachedSegments).toEqual([0]);
  });

  it('rejects malformed segment-1 checkpoint hidden states before side effects', async () => {
    const worker = makeSegment1Worker(true);
    const transport = makeTransport();

    await expect(worker.execute({
      requestId: 'request-seg1-invalid',
      prompt: 'hello',
      coordinatorUrl,
      cdnUrl,
      transport,
      checkpoint: {
        hiddenStates: 'not-bytes',
      },
    } as never)).rejects.toThrow(
      'prototype segment 1 checkpoint hiddenStates must be a Uint8Array',
    );
    expect(transport.connectionCount).toBe(0);
    expect(worker.snapshotMetadata().cachedSegments).toEqual([]);

    await expect(worker.execute({
      requestId: 'request-seg1-valid',
      prompt: 'hello',
      coordinatorUrl,
      cdnUrl,
      transport,
      checkpoint: {
        requestId: 'request-seg1-valid',
        segmentIndex: 0,
        hiddenStates: new TextEncoder().encode('HELLO'),
        metadata: {
          shape: [1, 1, 1],
          dtype: 'uint8',
          sequenceLength: 1,
          timestamp: Date.now(),
        },
      },
    } as never)).rejects.toThrow('Simulated worker loss');
  });

  it('fails closed for Proxy-wrapped segment-1 bytes before transport, cache, or fail-once state', async () => {
    const worker = makeSegment1Worker(true);
    const transport = makeTransport();
    const hiddenStates = new Proxy(new Uint8Array([72, 69, 76, 76, 79]), {});

    await expect(worker.execute({
      requestId: 'request-seg1-proxy',
      prompt: 'hello',
      coordinatorUrl,
      cdnUrl,
      transport,
      checkpoint: {
        requestId: 'request-seg1-proxy',
        segmentIndex: 0,
        hiddenStates,
        metadata: {
          shape: [1, 5, 1],
          dtype: 'uint8',
          sequenceLength: 5,
          timestamp: Date.now(),
        },
      },
    } as never)).rejects.toThrow(
      'prototype segment 1 checkpoint hiddenStates must be a Uint8Array',
    );

    expect(transport.connectionCount).toBe(0);
    expect(worker.snapshotMetadata().cachedSegments).toEqual([]);

    await expect(worker.execute({
      requestId: 'request-seg1-after-proxy',
      prompt: 'hello',
      coordinatorUrl,
      cdnUrl,
      transport,
      checkpoint: {
        requestId: 'request-seg1-after-proxy',
        segmentIndex: 0,
        hiddenStates: new TextEncoder().encode('HELLO'),
        metadata: {
          shape: [1, 5, 1],
          dtype: 'uint8',
          sequenceLength: 5,
          timestamp: Date.now(),
        },
      },
    } as never)).rejects.toThrow('Simulated worker loss');
  });

  it('owns genuine Uint8Array subclass bytes without caller-defined hooks', async () => {
    class HostileUint8Array extends Uint8Array {}
    const hiddenStates = new HostileUint8Array(new TextEncoder().encode('HELLO'));
    const hooks = {
      byteLength: 0,
      buffer: 0,
      byteOffset: 0,
      slice: 0,
      iterator: 0,
      constructor: 0,
    };

    Object.defineProperties(hiddenStates, {
      byteLength: {
        configurable: true,
        get() {
          hooks.byteLength += 1;
          return 999;
        },
      },
      buffer: {
        configurable: true,
        get() {
          hooks.buffer += 1;
          throw new Error('hostile buffer must not run');
        },
      },
      byteOffset: {
        configurable: true,
        get() {
          hooks.byteOffset += 1;
          throw new Error('hostile byteOffset must not run');
        },
      },
      slice: {
        configurable: true,
        value() {
          hooks.slice += 1;
          throw new Error('hostile slice must not run');
        },
      },
      [Symbol.iterator]: {
        configurable: true,
        value() {
          hooks.iterator += 1;
          throw new Error('hostile iterator must not run');
        },
      },
      constructor: {
        configurable: true,
        get() {
          hooks.constructor += 1;
          throw new Error('hostile constructor/species must not run');
        },
      },
    });

    const worker = makeSegment1Worker();
    const transport = makeTransport();
    const output = await worker.execute({
      requestId: 'request-seg1-hostile-subclass',
      prompt: 'ignored',
      coordinatorUrl,
      cdnUrl,
      transport,
      checkpoint: {
        requestId: 'request-seg1-hostile-subclass',
        segmentIndex: 0,
        hiddenStates,
        metadata: {
          shape: [1, 5, 1],
          dtype: 'uint8',
          sequenceLength: 5,
          timestamp: Date.now(),
        },
      },
    } as never);

    expect(output.text).toBe('proto-2b:HELLO');
    expect(output.checkpointBytes).toBe(5);
    expect(transport.connectionCount).toBe(3);
    expect(worker.snapshotMetadata().cachedSegments).toEqual([1]);
    expect(hooks).toEqual({
      byteLength: 0,
      buffer: 0,
      byteOffset: 0,
      slice: 0,
      iterator: 0,
      constructor: 0,
    });
  });

  it('keeps valid segment-0 and segment-1 execution behavior', async () => {
    const transport = makeTransport();
    const segment0 = makeSegment0Worker();
    const segment0Output = await segment0.execute({
      requestId: 'request-valid',
      prompt: '  hello   world ',
      coordinatorUrl,
      cdnUrl,
      transport,
    });

    expect(segment0Output.checkpoint?.hiddenStates).toEqual(
      new TextEncoder().encode('HELLO WORLD'),
    );
    expect(segment0.snapshotMetadata().cachedSegments).toEqual([0]);

    const segment1 = makeSegment1Worker();
    const segment1Output = await segment1.execute({
      requestId: 'request-valid',
      prompt: 'ignored-by-segment-1',
      coordinatorUrl,
      cdnUrl,
      transport,
      checkpoint: segment0Output.checkpoint,
    });

    expect(segment1Output.text).toBe('proto-2b:HELLO WORLD');
    expect(segment1.snapshotMetadata().cachedSegments).toEqual([1]);
  });
});
