import { describe, expect, it, vi } from 'vitest';
import { runDurableRecovery } from '../src/durable-recovery-runner.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { generateRequestId } from '../src/ids.js';
import type { RequestRecord } from '../src/durable-types.js';

const MANIFEST = 'manifest-recovery-signal-envelope';
const NOW = 500_000;

function seedQueued(repo: InMemoryRepository): RequestRecord {
  const record: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'recover malformed signal',
    stage: 'queued',
    createdAt: NOW,
    currentSegment: 0,
    totalSegments: 1,
    manifestDigest: MANIFEST,
    retryCount: 0,
  };
  repo.createRequest(record);
  return record;
}

function options(signal: AbortSignal, onResume = vi.fn(async () => {})) {
  return {
    ownerId: 'signal-envelope-owner',
    ownershipTtlMs: 1_000,
    ownershipRenewIntervalMs: 500,
    pollIntervalMs: 25,
    maxRetries: 2,
    manifestDigest: MANIFEST,
    now: () => NOW,
    signal,
    onResume,
  };
}

describe('durable recovery runner signal envelope', () => {
  it.each([
    ['null', null],
    ['array', []],
    ['missing listener methods', { aborted: false }],
    ['non-boolean aborted', {
      aborted: 'false',
      addEventListener() {},
      removeEventListener() {},
    }],
    ['non-callable addEventListener', {
      aborted: false,
      addEventListener: 1,
      removeEventListener() {},
    }],
    ['non-callable removeEventListener', {
      aborted: false,
      addEventListener() {},
      removeEventListener: 1,
    }],
  ])('rejects %s before durable recovery ownership can be claimed', async (_label, malformedSignal) => {
    const repo = new InMemoryRepository();
    const record = seedQueued(repo);
    const onResume = vi.fn(async () => {});

    await expect(runDurableRecovery(
      repo,
      record.requestId,
      options(malformedSignal as unknown as AbortSignal, onResume),
    )).rejects.toThrow(/Durable recovery signal/);

    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
    expect(repo.getActiveLease(record.requestId)).toBeUndefined();
    expect(repo.getRequest(record.requestId)?.stage).toBe('queued');
    expect(repo.listCheckpoints(record.requestId)).toHaveLength(0);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('releases a resume claim if a structural signal changes after entry validation', async () => {
    const repo = new InMemoryRepository();
    const record = seedQueued(repo);
    const onResume = vi.fn(async () => {});
    let addReads = 0;
    const hostileSignal = {
      aborted: false,
      get addEventListener() {
        addReads += 1;
        if (addReads === 1) return () => {};
        throw new Error('listener surface changed after validation');
      },
      removeEventListener() {},
    } as unknown as AbortSignal;

    await expect(runDurableRecovery(
      repo,
      record.requestId,
      options(hostileSignal, onResume),
    )).rejects.toThrow('Durable recovery signal could not be subscribed');

    expect(addReads).toBe(2);
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
    expect(repo.getRequest(record.requestId)?.stage).toBe('queued');
    expect(onResume).not.toHaveBeenCalled();
  });

  it('continues to accept an AbortSignal-compatible structural signal', async () => {
    const repo = new InMemoryRepository();
    const record = seedQueued(repo);
    const listeners = new Set<() => void>();
    const structuralSignal = {
      aborted: false,
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === 'abort' && typeof listener === 'function') listeners.add(listener as () => void);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === 'abort' && typeof listener === 'function') listeners.delete(listener as () => void);
      },
    } as unknown as AbortSignal;
    const onResume = vi.fn(async () => {});

    const result = await runDurableRecovery(
      repo,
      record.requestId,
      options(structuralSignal, onResume),
    );

    expect(result.kind).toBe('resumed');
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
    expect(listeners.size).toBe(0);
  });
});
