import { describe, expect, it } from 'vitest';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerResponse,
} from '../src/worker/worker-protocol';
import {
  handleWorkerMessage,
  type WorkerState,
} from '../src/worker/quickjs-worker';

function limitedGetter<T>(
  reads: Map<string, number>,
  name: string,
  value: T,
  maxReads: number,
): () => T {
  return () => {
    const count = (reads.get(name) ?? 0) + 1;
    reads.set(name, count);
    if (count > maxReads) throw new Error(`${name} read too many times`);
    return value;
  };
}

describe('QuickJS rejected-message correlation boundary', () => {
  it('snapshots init generationId before building a rejection response', async () => {
    const reads = new Map<string, number>();
    const request = {
      get protocolVersion() {
        return limitedGetter(
          reads,
          'protocolVersion',
          WORKER_PROTOCOL_VERSION + 1,
          1,
        )();
      },
      get generationId() {
        return limitedGetter(reads, 'generationId', 7, 2)();
      },
      get type() {
        return limitedGetter(reads, 'type', 'init' as const, 2)();
      },
    };
    const state: WorkerState = { quickJS: null };
    const responses: WorkerResponse[] = [];

    await handleWorkerMessage({ data: request }, state, (msg) => responses.push(msg));

    expect(responses).toEqual([{
      type: 'init-result',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      generationId: 7,
      success: false,
      error: expect.stringContaining('protocol version mismatch'),
    }]);
    expect(reads.get('generationId')).toBe(2);
    expect(reads.get('type')).toBe(2);
    expect(state.quickJS).toBeNull();
  });

  it.each(['execute', 'cancel'] as const)(
    'snapshots %s requestId and generationId before rejection correlation',
    async (type) => {
      const reads = new Map<string, number>();
      const request = {
        get protocolVersion() {
          return limitedGetter(
            reads,
            'protocolVersion',
            WORKER_PROTOCOL_VERSION + 1,
            1,
          )();
        },
        get generationId() {
          return limitedGetter(reads, 'generationId', 9, 2)();
        },
        get type() {
          return limitedGetter(reads, 'type', type, 2)();
        },
        get requestId() {
          return limitedGetter(reads, 'requestId', 'req-rejected', 1)();
        },
      };
      const state: WorkerState = { quickJS: null };
      const responses: WorkerResponse[] = [];

      await handleWorkerMessage({ data: request }, state, (msg) => responses.push(msg));

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: type === 'execute' ? 'execute-result' : 'cancel-result',
        requestId: 'req-rejected',
        generationId: 9,
        success: false,
        error: expect.stringContaining('protocol version mismatch'),
      });
      if (type === 'execute') {
        expect(responses[0]).toMatchObject({ errorType: 'runtime_error' });
      }
      expect(reads.get('generationId')).toBe(2);
      expect(reads.get('type')).toBe(2);
      expect(reads.get('requestId')).toBe(1);
      expect(state.quickJS).toBeNull();
    },
  );

  it('still ignores an unaddressable rejected request', async () => {
    const state: WorkerState = { quickJS: null };
    const responses: WorkerResponse[] = [];

    await handleWorkerMessage({
      data: {
        type: 'execute',
        protocolVersion: WORKER_PROTOCOL_VERSION + 1,
        generationId: 1,
        requestId: '',
      },
    }, state, (msg) => responses.push(msg));

    expect(responses).toEqual([]);
    expect(state.quickJS).toBeNull();
  });
});
