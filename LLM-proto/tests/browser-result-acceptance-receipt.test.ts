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

function validProfileEvidence(overrides: Record<string, unknown> = {}) {
  return {
    method: 'coordinator-issued-http-only-cookie',
    confirmed: true,
    sourceWorkerId: 'browser-a',
    sourceWorkerGeneration: 1,
    segment1WorkerId: 'browser-b',
    segment1WorkerGeneration: 1,
    sourceProfileProbeHash: 'c'.repeat(64),
    segment1ProfileProbeHash: 'd'.repeat(64),
    ...overrides,
  };
}

function validReceipt(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    idempotent: false,
    runId: 'run-1',
    profileIsolationConfirmed: true,
    profileIsolationEvidence: validProfileEvidence(),
    checkpointId: 'checkpoint-00000000-0000-4000-8000-000000000000',
    checkpointDigest: 'a'.repeat(64),
    resultDigest: 'b'.repeat(64),
    ...overrides,
  };
}

describe('browser result acceptance receipt boundary', () => {
  it('parses and validates a valid BOM-prefixed metadata receipt', async () => {
    const receipt = validReceipt();
    const bytes = concatBytes(
      new Uint8Array([0xef, 0xbb, 0xbf]),
      new TextEncoder().encode(JSON.stringify(receipt)),
    );

    await expect(readResultAcceptanceReceipt(new Response(bytes))).resolves.toEqual(receipt);
  });

  it('accepts the Coordinator idempotent success receipt shape', async () => {
    const receipt = validReceipt({ idempotent: true });
    await expect(readResultAcceptanceReceipt(
      new Response(JSON.stringify(receipt)),
    )).resolves.toEqual(receipt);
  });

  it.each([
    [{ ok: false }, /successful Coordinator write/],
    [{ idempotent: 'false' }, /successful Coordinator write/],
    [{ runId: 'bad/run' }, /invalid run ID/],
    [{ resultDigest: 'B'.repeat(64) }, /invalid result digest/],
    [{ checkpointId: '' }, /invalid checkpoint ID/],
    [{ checkpointId: 'x'.repeat(129) }, /invalid checkpoint ID/],
    [{ checkpointDigest: 'A'.repeat(64) }, /invalid checkpoint digest/],
    [{ profileIsolationConfirmed: false }, /does not confirm browser profile isolation/],
    [{ profileIsolationEvidence: null }, /invalid profile isolation evidence/],
    [{ profileIsolationEvidence: validProfileEvidence({ method: 'self-reported' }) }, /invalid profile isolation evidence/],
    [{ profileIsolationEvidence: validProfileEvidence({ sourceWorkerId: 'bad/source' }) }, /invalid profile isolation worker identity/],
    [{ profileIsolationEvidence: validProfileEvidence({ sourceWorkerGeneration: 0 }) }, /invalid profile isolation worker generation/],
    [{ profileIsolationEvidence: validProfileEvidence({ sourceProfileProbeHash: 'C'.repeat(64) }) }, /invalid profile isolation probe hashes/],
    [{ profileIsolationEvidence: validProfileEvidence({ segment1ProfileProbeHash: 'c'.repeat(64) }) }, /invalid profile isolation probe hashes/],
  ])('rejects malformed successful result receipt metadata: %j', async (overrides, expected) => {
    await expect(readResultAcceptanceReceipt(
      new Response(JSON.stringify(validReceipt(overrides))),
    )).rejects.toThrow(expected);
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
