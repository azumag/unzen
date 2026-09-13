import { describe, expect, it } from 'vitest';
import type { WorkerRegistration } from '../src/protocol.js';
import { WorkerPool } from '../src/worker-pool.js';

describe('WorkerPool registration container validation', () => {
  it.each([null, 42, 'worker', [], Symbol('registration')])(
    'rejects malformed runtime registration containers before pool mutation',
    (runtimeRegistration) => {
      const pool = new WorkerPool();

      expect(() => pool.register(runtimeRegistration as unknown as WorkerRegistration))
        .toThrow(/worker registration must be a non-null object/);
      expect(pool.size).toBe(0);
      expect(pool.idleCount).toBe(0);
    },
  );
});
