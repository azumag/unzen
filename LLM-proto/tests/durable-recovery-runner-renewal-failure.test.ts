import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDurableRecovery } from '../src/durable-recovery-runner.js';
import {
  InMemoryRepository,
  type RecoveryOwnership,
  type RecoveryOwnershipClaim,
} from '../src/durable-repository.js';
import { generateRequestId } from '../src/ids.js';
import type { RequestRecord } from '../src/durable-types.js';

const START = 150_000;
const MANIFEST = 'manifest-recovery-runner-renewal-failure';

function seed(repo: InMemoryRepository): RequestRecord {
  const record: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'renewal failure containment',
    stage: 'queued',
    createdAt: START,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: MANIFEST,
    retryCount: 0,
  };
  repo.createRequest(record);
  return record;
}

class ThrowOnRenewRepository extends InMemoryRepository {
  claims = 0;

  constructor(private readonly renewalError: Error) {
    super();
  }

  override claimRecoveryOwnership(
    ownership: RecoveryOwnership,
    now: number,
  ): RecoveryOwnershipClaim {
    this.claims += 1;
    if (this.claims > 1) throw this.renewalError;
    return super.claimRecoveryOwnership(ownership, now);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('durable recovery runner renewal failure containment', () => {
  it('aborts a cooperative resume and propagates a repository renewal failure', async () => {
    vi.useFakeTimers();
    const renewalError = new Error('renewal repository failed');
    const repo = new ThrowOnRenewRepository(renewalError);
    const record = seed(repo);
    let resumeSignal: AbortSignal | undefined;
    let markResumeStarted!: () => void;
    const resumeStarted = new Promise<void>((resolve) => {
      markResumeStarted = resolve;
    });

    const runPromise = runDurableRecovery(repo, record.requestId, {
      ownerId: 'renewal-failure-owner',
      ownershipTtlMs: 1_000,
      ownershipRenewIntervalMs: 10,
      pollIntervalMs: 25,
      maxRetries: 2,
      manifestDigest: MANIFEST,
      now: () => START,
      onResume: ({ signal }) => new Promise<void>((_resolve, reject) => {
        resumeSignal = signal;
        const onAbort = () => reject(new DOMException('AbortError', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        // Mirror the production check-listen-recheck discipline so the test
        // cannot lose an abort if fake-timer scheduling interleaves here.
        if (signal.aborted) onAbort();
        markResumeStarted();
      }),
    });
    // Attach the rejection observer before advancing the timer that can make
    // runPromise reject. Vitest treats a transiently unhandled rejection as a
    // test failure even when an assertion is attached later in the same test.
    const runExpectation = expect(runPromise).rejects.toBe(renewalError);

    await resumeStarted;
    await vi.advanceTimersByTimeAsync(10);

    await runExpectation;
    expect(resumeSignal?.aborted).toBe(true);
    expect(repo.claims).toBe(2);
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
  });

  it('rejects with the captured renewal failure even when resume ignores abort', async () => {
    vi.useFakeTimers();
    const renewalError = new Error('renewal failed while resume ignored abort');
    const repo = new ThrowOnRenewRepository(renewalError);
    const record = seed(repo);
    let resumeSignal: AbortSignal | undefined;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });

    const runPromise = runDurableRecovery(repo, record.requestId, {
      ownerId: 'renewal-ignored-abort-owner',
      ownershipTtlMs: 1_000,
      ownershipRenewIntervalMs: 10,
      pollIntervalMs: 25,
      maxRetries: 2,
      manifestDigest: MANIFEST,
      now: () => START,
      onResume: async ({ signal }) => {
        resumeSignal = signal;
        await resumeGate;
      },
    });
    const runExpectation = expect(runPromise).rejects.toBe(renewalError);

    await vi.advanceTimersByTimeAsync(10);
    expect(resumeSignal?.aborted).toBe(true);
    releaseResume();

    await runExpectation;
    expect(repo.claims).toBe(2);
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
  });

  it('contains renewal clock failures inside the runner timer lifecycle', async () => {
    vi.useFakeTimers();
    const renewalError = new Error('renewal clock failed');
    const repo = new InMemoryRepository();
    const record = seed(repo);
    let clockReads = 0;
    let resumeSignal: AbortSignal | undefined;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });

    const runPromise = runDurableRecovery(repo, record.requestId, {
      ownerId: 'renewal-clock-owner',
      ownershipTtlMs: 1_000,
      ownershipRenewIntervalMs: 10,
      pollIntervalMs: 25,
      maxRetries: 2,
      manifestDigest: MANIFEST,
      now: () => {
        clockReads += 1;
        if (clockReads > 1) throw renewalError;
        return START;
      },
      onResume: async ({ signal }) => {
        resumeSignal = signal;
        await resumeGate;
      },
    });
    const runExpectation = expect(runPromise).rejects.toBe(renewalError);

    await vi.advanceTimersByTimeAsync(10);
    expect(resumeSignal?.aborted).toBe(true);
    releaseResume();

    await runExpectation;
    expect(clockReads).toBe(2);
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
  });
});
