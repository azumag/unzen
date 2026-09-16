import { describe, expect, it, vi } from 'vitest';
import { runDurableRecovery } from '../src/durable-recovery-runner.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { generateRequestId } from '../src/ids.js';
import type { RequestRecord } from '../src/durable-types.js';

const MANIFEST = 'manifest-recovery-wait-signal';
const NOW = 700_000;

function seedPeerOwnedRequest(repo: InMemoryRepository): RequestRecord {
  const record: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'wait behind peer recovery owner',
    stage: 'queued',
    createdAt: NOW,
    currentSegment: 0,
    totalSegments: 1,
    manifestDigest: MANIFEST,
    retryCount: 0,
  };
  repo.createRequest(record);
  repo.claimRecoveryOwnership({
    requestId: record.requestId,
    ownerId: 'peer-owner',
    claimedAt: NOW,
    expiresAt: NOW + 1_000,
  }, NOW);
  return record;
}

function options(signal: AbortSignal, onResume = vi.fn(async () => {})) {
  return {
    ownerId: 'local-owner',
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

describe('durable recovery bounded wait AbortSignal cleanup', () => {
  it('settles with AbortError even when listener removal throws', async () => {
    const repo = new InMemoryRepository();
    const record = seedPeerOwnedRequest(repo);
    const onResume = vi.fn(async () => {});
    let aborted = false;
    let listener: (() => void) | undefined;
    const signal = {
      get aborted() {
        return aborted;
      },
      addEventListener(type: string, candidate: EventListenerOrEventListenerObject) {
        if (type === 'abort' && typeof candidate === 'function') listener = candidate as () => void;
      },
      removeEventListener() {
        throw new Error('cleanup exploded');
      },
    } as unknown as AbortSignal;

    const recovery = runDurableRecovery(repo, record.requestId, options(signal, onResume));
    expect(listener).toBeTypeOf('function');

    aborted = true;
    expect(() => listener!()).not.toThrow();
    await expect(recovery).rejects.toMatchObject({ name: 'AbortError' });

    expect(repo.getRecoveryOwnership(record.requestId)?.ownerId).toBe('peer-owner');
    expect(repo.getRequest(record.requestId)?.stage).toBe('queued');
    expect(onResume).not.toHaveBeenCalled();
  });

  it('rejects when addEventListener changes after entry validation', async () => {
    const repo = new InMemoryRepository();
    const record = seedPeerOwnedRequest(repo);
    const onResume = vi.fn(async () => {});
    let addReads = 0;
    const signal = {
      aborted: false,
      get addEventListener() {
        addReads += 1;
        if (addReads === 1) return () => {};
        throw new Error('listener surface changed');
      },
      removeEventListener() {},
    } as unknown as AbortSignal;

    await expect(runDurableRecovery(
      repo,
      record.requestId,
      options(signal, onResume),
    )).rejects.toThrow('Durable recovery wait signal could not be subscribed');

    expect(addReads).toBe(2);
    expect(repo.getRecoveryOwnership(record.requestId)?.ownerId).toBe('peer-owner');
    expect(repo.getRequest(record.requestId)?.stage).toBe('queued');
    expect(onResume).not.toHaveBeenCalled();
  });

  it('rejects if signal state becomes unreadable after wait subscription', async () => {
    const repo = new InMemoryRepository();
    const record = seedPeerOwnedRequest(repo);
    const onResume = vi.fn(async () => {});
    let subscribed = false;
    const signal = {
      get aborted() {
        if (subscribed) throw new Error('state surface changed');
        return false;
      },
      addEventListener() {
        subscribed = true;
      },
      removeEventListener() {},
    } as unknown as AbortSignal;

    await expect(runDurableRecovery(
      repo,
      record.requestId,
      options(signal, onResume),
    )).rejects.toThrow('Durable recovery wait signal could not be subscribed');

    expect(subscribed).toBe(true);
    expect(repo.getRecoveryOwnership(record.requestId)?.ownerId).toBe('peer-owner');
    expect(repo.getRequest(record.requestId)?.stage).toBe('queued');
    expect(onResume).not.toHaveBeenCalled();
  });
});
