import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCheckpointPayloadResponse } from '../browser-harness/webgpu-2b-split/checkpoint-payload-response.js';
import {
  COORDINATOR_CHECKPOINT_RESPONSE_MAX_BYTES,
  COORDINATOR_JSON_REQUEST_MAX_BYTES,
} from '../browser-harness/webgpu-2b-split/checkpoint-transport-contract.js';

const runner = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-v3.js', import.meta.url),
  'utf8',
);
const coordinator = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/serve.mjs', import.meta.url),
  'utf8',
);

function concatBytes(...parts: Uint8Array[]) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

describe('browser checkpoint payload response boundary', () => {
  it('parses a valid BOM-prefixed checkpoint payload', async () => {
    const checkpoint = {
      checkpointId: 'checkpoint-1',
      checkpointDigest: 'digest',
      tensors: [],
    };
    const bytes = concatBytes(
      new Uint8Array([0xef, 0xbb, 0xbf]),
      new TextEncoder().encode(JSON.stringify(checkpoint)),
    );

    await expect(readCheckpointPayloadResponse(new Response(bytes))).resolves.toEqual(checkpoint);
  });

  it('fails closed on malformed UTF-8 before JSON parsing', async () => {
    const prefix = new TextEncoder().encode('{"checkpointId":"');
    const suffix = new TextEncoder().encode('","tensors":[]}');
    const bytes = concatBytes(prefix, new Uint8Array([0xc3, 0x28]), suffix);

    await expect(readCheckpointPayloadResponse(new Response(bytes))).rejects.toBeInstanceOf(TypeError);
  });

  it('cancels a response declared above the checkpoint transport ceiling', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x7b, 0x7d]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream, {
      headers: {
        'Content-Length': String(COORDINATOR_CHECKPOINT_RESPONSE_MAX_BYTES + 1),
      },
    });

    await expect(readCheckpointPayloadResponse(response)).rejects.toThrow(/exceeds byte limit/);
    expect(cancelled).toBe(true);
  });

  it('derives the browser ceiling from the Coordinator request limit plus bounded relay metadata', () => {
    expect(COORDINATOR_JSON_REQUEST_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(COORDINATOR_CHECKPOINT_RESPONSE_MAX_BYTES).toBeGreaterThan(COORDINATOR_JSON_REQUEST_MAX_BYTES);
    expect(coordinator).toContain('const MAX_JSON_BYTES = 16 * 1024 * 1024;');
  });

  it('routes segment-1 checkpoint polling through the bounded payload reader', () => {
    const match = runner.match(
      /async function waitForCheckpoint\([\s\S]*?\n\}\n\nasync function runSegment1/,
    );
    expect(match).not.toBeNull();
    const body = match?.[0] ?? '';

    expect(runner).toContain("import { readCheckpointPayloadResponse } from './checkpoint-payload-response.js';");
    expect(body).toContain('readCheckpointResponse: (response, responseSignal) => readCheckpointPayloadResponse(');
    expect(body).not.toContain('response.json()');
  });
});
