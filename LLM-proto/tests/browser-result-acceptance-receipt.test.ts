import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_RESULT_ACCEPTANCE_RECEIPT_BYTES,
  readResultAcceptanceReceipt,
} from '../browser-harness/webgpu-2b-split/result-acceptance-receipt.js';

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

describe('browser result acceptance receipt boundary', () => {
  it('parses a valid BOM-prefixed metadata receipt', async () => {
    const receipt = {
      profileIsolationConfirmed: true,
      checkpointId: 'checkpoint-1',
      checkpointDigest: 'checkpoint-sha256',
      resultDigest: 'result-sha256',
    };
    const bytes = concatBytes(
      new Uint8Array([0xef, 0xbb, 0xbf]),
      new TextEncoder().encode(JSON.stringify(receipt)),
    );

    await expect(readResultAcceptanceReceipt(new Response(bytes))).resolves.toEqual(receipt);
  });

  it('fails closed on malformed UTF-8 before JSON parsing', async () => {
    const prefix = new TextEncoder().encode('{"resultDigest":"');
    const suffix = new TextEncoder().encode('","profileIsolationConfirmed":true}');
    const bytes = concatBytes(prefix, new Uint8Array([0xc3, 0x28]), suffix);

    await expect(readResultAcceptanceReceipt(new Response(bytes))).rejects.toBeInstanceOf(TypeError);
  });

  it('cancels an oversized streamed receipt before parsing it', async () => {
    let cancelled = false;
    const oversized = new Uint8Array(MAX_RESULT_ACCEPTANCE_RECEIPT_BYTES + 1);
    oversized.fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readResultAcceptanceReceipt(new Response(stream))).rejects.toThrow(/exceeds byte limit/);
    expect(cancelled).toBe(true);
  });

  it('routes the segment-1 success response through the bounded reader', () => {
    const match = runner.match(
      /async function runSegment1\([\s\S]*?\n\}\n\nasync function execute/,
    );
    expect(match).not.toBeNull();
    const body = match?.[0] ?? '';

    expect(runner).toContain("import { readResultAcceptanceReceipt } from './result-acceptance-receipt.js';");
    expect(body).toContain('const accepted = await readResultAcceptanceReceipt(response, { signal });');
    expect(body).not.toContain('const accepted = await response.json();');
  });
});
