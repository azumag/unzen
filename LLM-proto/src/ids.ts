/**
 * Collision-resistant identifier generation (issue #103).
 *
 * The legacy prototype used process-local `req-1` counters which collide
 * across Coordinator instances and are guessable. This module generates
 * RFC 9562 UUIDv7-style IDs (48-bit millisecond timestamp prefix makes them
 * time-ordered, so they can be sorted and sharded by time) with a monotonic
 * suffix so that even when the clock is frozen or randomness is weak, no two
 * IDs generated in one process ever collide.
 *
 * Namespaces (separate generation per concern per the issue):
 *   - request   (one per API request; also used as the request identity)
 *   - attempt   (one per execution attempt of a segment)
 *   - lease     (one per worker lease of an attempt)
 *   - generation(one per worker transport connection / auth session)
 *
 * The suffix also carries the namespace marker so IDs are self-describing.
 */

import type { InferenceRequestId } from './types.js';

// --- Branded ID types (compile-time safety, like types.ts) ---

export type AttemptId = string & { readonly __brand: 'AttemptId' };
export type LeaseId = string & { readonly __brand: 'LeaseId' };
export type WorkerGeneration = string & { readonly __brand: 'WorkerGeneration' };
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };

// Process-local monotonic counter. Guarantees uniqueness of the suffix even
// when multiple IDs are generated within the same millisecond (or under fake
// timers with a frozen clock during tests).
let monotonicCounter = 0;

function nextMonotonicSuffix(): string {
  monotonicCounter = (monotonicCounter + 1) >>> 0;
  return monotonicCounter.toString(36).padStart(5, '0');
}

/**
 * Generate an RFC 9562 UUIDv7 value.
 *
 * Layout: 48-bit big-endian unix timestamp in milliseconds (bytes 0..5),
 * version nibble 7 (byte 6 high), 12 random bits, variant 10xx (byte 8 high),
 * and 62 further random bits. The timestamp prefix makes values roughly
 * time-ordered, which is enough for debugging, sharding, and restart-safe
 * monotonicity without a central counter.
 */
export function uuidV7(): string {
  const bytes = new Uint8Array(16);
  let timeMs = BigInt(Date.now());
  // Write the 48-bit millisecond timestamp big-endian into bytes 0..5.
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timeMs & BigInt(0xff));
    timeMs >>= BigInt(8);
  }
  // Fill the remaining 10 bytes with cryptographically strong randomness.
  globalThis.crypto.getRandomValues(bytes.subarray(6, 16));
  // Set version 7 (high nibble of byte 6).
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Set the RFC 9562 variant 10xx (high bits of byte 8).
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Build a namespaced, collision-resistant ID string. */
function generate(kind: string): string {
  return `${uuidV7()}-${kind}${nextMonotonicSuffix()}`;
}

/** One API inference request (issue #103: UUIDv7, not `req-${counter}`). */
export function generateRequestId(): InferenceRequestId {
  return generate('req') as InferenceRequestId;
}

/** One execution attempt of a segment. */
export function generateAttemptId(): AttemptId {
  return generate('att') as AttemptId;
}

/** One worker lease. */
export function generateLeaseId(): LeaseId {
  return generate('lea') as LeaseId;
}

/** One worker transport connection / auth session generation. */
export function generateWorkerGeneration(): WorkerGeneration {
  return generate('gen') as WorkerGeneration;
}

/** Brand an API caller-supplied idempotency key. */
export function idempotencyKey(key: string): IdempotencyKey {
  return key as IdempotencyKey;
}
