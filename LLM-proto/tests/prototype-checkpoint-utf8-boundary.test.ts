import { describe, expect, it } from 'vitest';
import {
  AllowlistedPrototypeTransport,
  SimulatedPrototypeWorker,
} from '../src/two-worker-prototype.js';

const coordinatorUrl = 'https://coordinator.unzen.local';
const cdnUrl = 'https://cdn.unzen.local';

function checkpoint(hiddenStates: Uint8Array) {
  return {
    requestId: 'relay-request',
    segmentIndex: 0,
    hiddenStates,
    metadata: {
      shape: [1, hiddenStates.byteLength, 1] as const,
      dtype: 'uint8' as const,
      sequenceLength: hiddenStates.byteLength,
      timestamp: 0,
    },
  };
}

describe('simulated prototype checkpoint UTF-8 boundary', () => {
  it('rejects malformed relay bytes before transport, cache, or fail-once state changes', async () => {
    const transport = new AllowlistedPrototypeTransport([coordinatorUrl, cdnUrl]);
    const worker = new SimulatedPrototypeWorker({
      id: 'strict-relay-segment-1',
      segmentIndex: 1,
      webgpuAdapter: 'test-adapter',
      vramMB: 2048,
      failFirstRun: true,
    });
    const malformed = new Uint8Array([0x48, 0xff, 0x49]);

    expect(new TextDecoder().decode(malformed)).toContain('\ufffd');
    await expect(worker.execute({
      requestId: 'invalid-relay',
      prompt: 'ignored',
      coordinatorUrl,
      cdnUrl,
      transport,
      checkpoint: checkpoint(malformed),
    } as never)).rejects.toThrow(
      'prototype segment 1 checkpoint hiddenStates must be valid UTF-8',
    );

    expect(transport.connectionCount).toBe(0);
    expect(worker.snapshotMetadata().cachedSegments).toEqual([]);

    await expect(worker.execute({
      requestId: 'valid-relay-after-invalid',
      prompt: 'ignored',
      coordinatorUrl,
      cdnUrl,
      transport,
      checkpoint: checkpoint(new TextEncoder().encode('HELLO')),
    } as never)).rejects.toThrow('Simulated worker loss');
  });
});
