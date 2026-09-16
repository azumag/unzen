import { describe, expect, it } from 'vitest';
import { runDurableRecovery } from '../src/durable-recovery-runner.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { MAX_TIMER_DELAY_MS } from '../src/pipeline-utils.js';
import { inferenceRequestId } from '../src/types.js';

function options(overrides: Partial<Parameters<typeof runDurableRecovery>[2]> = {}) {
  return {
    ownerId: 'timer-range-owner',
    ownershipTtlMs: 1_000,
    ownershipRenewIntervalMs: 500,
    pollIntervalMs: 25,
    maxRetries: 0,
    manifestDigest: 'a'.repeat(64),
    onResume: async () => {},
    ...overrides,
  };
}

describe('durable recovery runner host timer range', () => {
  it.each(['ownershipRenewIntervalMs', 'pollIntervalMs'] as const)(
    'accepts maximum representable %s and rejects one millisecond above it before repository work',
    async (field) => {
      const requestId = inferenceRequestId('missing-timer-range');
      await expect(runDurableRecovery(
        new InMemoryRepository(),
        requestId,
        options({ [field]: MAX_TIMER_DELAY_MS }),
      )).resolves.toEqual({ kind: 'missing' });

      let repositoryReads = 0;
      const repository = new Proxy({}, {
        get() {
          repositoryReads += 1;
          throw new Error('repository must not be touched');
        },
      });
      await expect(runDurableRecovery(
        repository as never,
        requestId,
        options({ [field]: MAX_TIMER_DELAY_MS + 1 }),
      )).rejects.toThrow(
        new RegExp(`Durable recovery ${field} must not exceed ${MAX_TIMER_DELAY_MS}ms`, 'i'),
      );
      expect(repositoryReads).toBe(0);
    },
  );

  it('does not impose the host timer maximum on recovery ownership TTL metadata', async () => {
    await expect(runDurableRecovery(
      new InMemoryRepository(),
      inferenceRequestId('missing-long-ttl'),
      options({ ownershipTtlMs: MAX_TIMER_DELAY_MS + 1 }),
    )).resolves.toEqual({ kind: 'missing' });
  });

  it('preserves zero poll and renewal controls', async () => {
    await expect(runDurableRecovery(
      new InMemoryRepository(),
      inferenceRequestId('missing-zero-timers'),
      options({ ownershipRenewIntervalMs: 0, pollIntervalMs: 0 }),
    )).resolves.toEqual({ kind: 'missing' });
  });
});
