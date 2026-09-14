import { describe, expect, it } from 'vitest';
import {
  beginDurableRecovery,
  type DurableRecoveryCommandOptions,
} from '../src/durable-recovery-command.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { generateRequestId } from '../src/ids.js';
import type { RequestRecord } from '../src/durable-types.js';

const MANIFEST = 'manifest-recovery-command-validation';

function seed(repo: InMemoryRepository): RequestRecord {
  const record: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'recovery option validation',
    stage: 'queued',
    createdAt: 0,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: MANIFEST,
    retryCount: 0,
  };
  repo.createRequest(record);
  return record;
}

function validOptions(): DurableRecoveryCommandOptions {
  return {
    ownerId: 'validation-owner',
    now: 1_000,
    ownershipTtlMs: 1_000,
    maxRetries: 2,
    manifestDigest: MANIFEST,
  };
}

describe('durable recovery command runtime option validation', () => {
  const malformedCases: ReadonlyArray<{
    readonly field: keyof DurableRecoveryCommandOptions;
    readonly value: unknown;
    readonly message: RegExp;
  }> = [
    { field: 'ownerId', value: '', message: /ownerId must be a non-empty string/ },
    { field: 'ownerId', value: Symbol('owner'), message: /ownerId must be a non-empty string/ },
    { field: 'now', value: -1, message: /now must be a non-negative finite number/ },
    { field: 'now', value: Number.NaN, message: /now must be a non-negative finite number/ },
    { field: 'now', value: Number.POSITIVE_INFINITY, message: /now must be a non-negative finite number/ },
    { field: 'ownershipTtlMs', value: -1, message: /ownershipTtlMs must be a non-negative finite number/ },
    { field: 'ownershipTtlMs', value: '1000', message: /ownershipTtlMs must be a non-negative finite number/ },
    { field: 'maxRetries', value: -1, message: /maxRetries must be a non-negative safe integer/ },
    { field: 'maxRetries', value: 1.5, message: /maxRetries must be a non-negative safe integer/ },
    { field: 'maxRetries', value: Number.MAX_SAFE_INTEGER + 1, message: /maxRetries must be a non-negative safe integer/ },
    { field: 'manifestDigest', value: '   ', message: /manifestDigest must be a non-empty string/ },
    { field: 'manifestDigest', value: Symbol('digest'), message: /manifestDigest must be a non-empty string/ },
  ];

  for (const { field, value, message } of malformedCases) {
    it(`rejects malformed ${field} before storing recovery ownership`, () => {
      const repo = new InMemoryRepository();
      const record = seed(repo);
      const runtimeOptions = {
        ...validOptions(),
        [field]: value,
      } as unknown as DurableRecoveryCommandOptions;

      expect(() => beginDurableRecovery(repo, record.requestId, runtimeOptions)).toThrow(message);
      expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
      expect(repo.getRequest(record.requestId)?.stage).toBe('queued');
      expect(repo.getActiveLease(record.requestId)).toBeUndefined();
      expect(repo.listCheckpoints(record.requestId)).toEqual([]);
    });
  }

  it('rejects a finite now/TTL pair whose ownership expiry overflows', () => {
    const repo = new InMemoryRepository();
    const record = seed(repo);

    expect(() => beginDurableRecovery(repo, record.requestId, {
      ...validOptions(),
      now: Number.MAX_VALUE,
      ownershipTtlMs: Number.MAX_VALUE,
    })).toThrow(/ownership expiry must be finite/);

    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
    expect(repo.getRequest(record.requestId)?.stage).toBe('queued');
  });

  it('accepts zero-valued time, ownership TTL, and retry controls', () => {
    const repo = new InMemoryRepository();
    const record = seed(repo);

    const result = beginDurableRecovery(repo, record.requestId, {
      ownerId: 'zero-owner',
      now: 0,
      ownershipTtlMs: 0,
      maxRetries: 0,
      manifestDigest: MANIFEST,
    });

    // A zero retry budget may make the planner terminalize immediately, but it
    // remains a valid runtime control rather than a malformed command option.
    expect(['resume-claimed', 'terminal']).toContain(result.kind);
  });
});
