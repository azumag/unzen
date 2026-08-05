/**
 * Unit tests for collision-resistant ID generation (issue #103).
 *
 * Verifies UUIDv7-style time-ordered format, uniqueness under bulk
 * generation, and that the monotonic suffix guarantees no process-local
 * collisions even when the clock is frozen.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generateRequestId,
  generateAttemptId,
  generateLeaseId,
  generateWorkerGeneration,
  idempotencyKey,
} from '../src/ids.js';
import type { InferenceRequestId } from '../src/types.js';

describe('ids', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates UUIDv7-formatted request IDs with a monotonic suffix', () => {
    const id = generateRequestId();
    // Format: 8-4-4-4-12 UUID + "-<kind><counter>" suffix.
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-req[0-9a-z]+$/,
    );
  });

  it('produces unique IDs at scale (bulk collision test)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(generateRequestId());
    }
    expect(ids.size).toBe(10_000);
  });

  it('is unique even when the clock is frozen (monotonic suffix)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
    const ids = new Set<string>();
    for (let i = 0; i < 5_000; i++) {
      ids.add(generateLeaseId());
    }
    expect(ids.size).toBe(5_000);
  });

  it('generates time-ordered IDs that sort chronologically', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
    const early = generateAttemptId();
    vi.setSystemTime(new Date('2026-08-06T00:00:01.000Z'));
    const late = generateAttemptId();
    expect(late > early).toBe(true);
  });

  it('separates attempt and lease ID namespaces', () => {
    const attempt = generateAttemptId();
    const lease = generateLeaseId();
    expect(attempt).toMatch(/-att[0-9a-z]+$/);
    expect(lease).toMatch(/-lea[0-9a-z]+$/);
  });

  it('produces distinct worker generations across calls', () => {
    const g1 = generateWorkerGeneration();
    const g2 = generateWorkerGeneration();
    expect(g1).not.toBe(g2);
    expect(g1).toMatch(/-gen[0-9a-z]+$/);
  });

  it('brands an API caller idempotency key', () => {
    const key = idempotencyKey('my-shop-invoice-42');
    // The branded type is a plain string at runtime.
    expect(String(key)).toBe('my-shop-invoice-42');
  });

  it('generated request IDs are compatible with the InferenceRequestId brand', () => {
    const id: InferenceRequestId = generateRequestId();
    expect(typeof id).toBe('string');
  });
});
