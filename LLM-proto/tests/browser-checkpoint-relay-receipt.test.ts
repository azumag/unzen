import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_CHECKPOINT_RELAY_RECEIPT_BYTES,
  readCheckpointRelayReceipt,
} from '../browser-harness/webgpu-2b-split/checkpoint-receipt.js';

const runner = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-v3.js', import.meta.url),
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

describe('browser checkpoint relay receipt boundary', () => {
  it('parses a valid BOM-prefixed metadata receipt', async () => {
    const receipt = {
      manifestDigest: 'manifest-sha256',
      checkpointId: 'checkpoint-1',
      checkpointDigest: 'checkpoint-sha256',
    };
    const bytes = concatBytes(
      new Uint8Array([0xef, 0xbb, 0xbf]),
      new TextEncoder().encode(JSON.stringify(receipt)),
    );

    await expect(readCheckpointRelayReceipt(new Response(bytes))).resolves.toEqual(receipt);
  });

  it('fails closed on malformed UTF-8 before JSON parsing', async () => {
    const prefix = new TextEncoder().encode('{"manifestDigest":"');
    const suffix = new TextEncoder().encode('","checkpointId":"cp","checkpointDigest":"digest"}');
    const bytes = concatBytes(prefix, new Uint8Array([0xc3, 0x28]), suffix);

    await expect(readCheckpointRelayReceipt(new Response(bytes))).rejects.toBeInstanceOf(TypeError);
  });

  it('cancels an oversized streamed receipt before parsing it', async () => {
    let cancelled = false;
    const oversized = new Uint8Array(MAX_CHECKPOINT_RELAY_RECEIPT_BYTES + 1);
    oversized.fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readCheckpointRelayReceipt(new Response(stream))).rejects.toThrow(/exceeds byte limit/);
    expect(cancelled).toBe(true);
  });

  it('routes the segment-0 success receipt through the bounded reader', () => {
    const match = runner.match(
      /async function runSegment0\([\s\S]*?\n\}\n\nasync function waitForCheckpoint/,
    );
    expect(match).not.toBeNull();
    const body = match?.[0] ?? '';

    expect(runner).toContain("import { readCheckpointRelayReceipt } from './checkpoint-receipt.js';");
    expect(body).toContain('const receipt = await readCheckpointRelayReceipt(response, { signal });');
    expect(body).not.toContain('const receipt = await response.json();');
  });
});
