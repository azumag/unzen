import { describe, expect, it } from 'vitest';
import {
  AllowlistedPrototypeTransport,
  SimulatedPrototypeWorker,
} from '../src/two-worker-prototype.js';

const coordinatorUrl = 'https://coordinator.unzen.local';
const cdnUrl = 'https://cdn.unzen.local';

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

  it.each([
    ['requestId', { requestId: Symbol('request') }],
    ['prompt', { prompt: 123 }],
    ['coordinatorUrl', { coordinatorUrl: 'not-an-absolute-url' }],
    ['cdnUrl', { cdnUrl: null }],
    ['transport', { transport: {} }],
  ])('preflights malformed %s before transport, cache, and fail-once state', async (_field, patch) => {
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
