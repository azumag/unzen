import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_CHECKPOINT_RELAY_RECEIPT_BYTES,
  readCheckpointRelayReceipt,
} from '../browser-harness/webgpu-2b-split/checkpoint-receipt.js';
import { resolveCoordinatorReceiptExpectedRunId } from '../browser-harness/webgpu-2b-split/coordinator-receipt-run-binding.js';

const runner = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-v3.js', import.meta.url),
  'utf8',
);
const EXPECTED_RUN_ID = 'run-1';

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

function validReceipt(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    idempotent: false,
    runId: EXPECTED_RUN_ID,
    relayOwner: 'coordinator',
    manifestDigest: 'a'.repeat(64),
    checkpointId: 'checkpoint-00000000-0000-4000-8000-000000000000',
    checkpointDigest: 'b'.repeat(64),
    sourceWorkerGeneration: 1,
    profileProbeConfirmed: true,
    tensorBytes: 32,
    ...overrides,
  };
}

function readReceipt(response: Response) {
  return readCheckpointRelayReceipt(response, { expectedRunId: EXPECTED_RUN_ID });
}

describe('browser checkpoint relay receipt boundary', () => {
  it('parses and validates a valid BOM-prefixed metadata receipt', async () => {
    const receipt = validReceipt();
    const bytes = concatBytes(
      new Uint8Array([0xef, 0xbb, 0xbf]),
      new TextEncoder().encode(JSON.stringify(receipt)),
    );

    await expect(readReceipt(new Response(bytes))).resolves.toEqual(receipt);
  });

  it('accepts the Coordinator idempotent success receipt shape', async () => {
    const receipt = validReceipt({ idempotent: true });
    await expect(readReceipt(
      new Response(JSON.stringify(receipt)),
    )).resolves.toEqual(receipt);
  });

  it('fails closed on a structurally valid receipt for a different requested run', async () => {
    await expect(readReceipt(
      new Response(JSON.stringify(validReceipt({ runId: 'run-2' }))),
    )).rejects.toThrow(/bound to a different run ID/);
  });

  it('derives the browser request run ID from the immutable run query parameter', () => {
    expect(resolveCoordinatorReceiptExpectedRunId(undefined, '?run=run-42')).toBe('run-42');
    expect(resolveCoordinatorReceiptExpectedRunId(undefined, '')).toBe('demo');
    expect(() => resolveCoordinatorReceiptExpectedRunId(undefined, '?run=bad%2Frun')).toThrow(/expected run ID is invalid/);
  });

  it.each([
    [{ ok: false }, /successful Coordinator write/],
    [{ idempotent: 'false' }, /successful Coordinator write/],
    [{ relayOwner: 'worker' }, /not Coordinator-owned/],
    [{ runId: 'bad/run' }, /invalid run ID/],
    [{ manifestDigest: 'A'.repeat(64) }, /invalid manifest digest/],
    [{ checkpointId: '' }, /invalid checkpoint ID/],
    [{ checkpointId: 'x'.repeat(129) }, /invalid checkpoint ID/],
    [{ checkpointDigest: 'B'.repeat(64) }, /invalid checkpoint digest/],
    [{ sourceWorkerGeneration: 0 }, /invalid source worker generation/],
    [{ sourceWorkerGeneration: '1' }, /invalid source worker generation/],
    [{ profileProbeConfirmed: false }, /does not confirm profile isolation/],
    [{ tensorBytes: 0 }, /invalid tensor byte count/],
    [{ tensorBytes: 1.5 }, /invalid tensor byte count/],
  ])('rejects malformed successful receipt metadata: %j', async (overrides, expected) => {
    await expect(readReceipt(
      new Response(JSON.stringify(validReceipt(overrides))),
    )).rejects.toThrow(expected);
  });

  it('fails closed on malformed UTF-8 before JSON parsing', async () => {
    const prefix = new TextEncoder().encode('{"manifestDigest":"');
    const suffix = new TextEncoder().encode('","checkpointId":"cp","checkpointDigest":"digest"}');
    const bytes = concatBytes(prefix, new Uint8Array([0xc3, 0x28]), suffix);

    await expect(readReceipt(new Response(bytes))).rejects.toBeInstanceOf(TypeError);
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

    await expect(readReceipt(new Response(stream))).rejects.toThrow(/exceeds byte limit/);
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
