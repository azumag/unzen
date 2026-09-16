import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableCoordinator } from '../src/durable-coordinator.js';
import type { DurableSegmentExecutor } from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { ErrorCode, UnzenCancelledError } from '../src/errors.js';
import { generateRequestId } from '../src/ids.js';
import { workerId, WorkerTier } from '../src/types.js';
import type { ExecutionAssignment, RequestRecord } from '../src/durable-types.js';

function abortDuringSubscriptionSignal(): {
  readonly signal: AbortSignal;
  readonly addCount: () => number;
  readonly removeCount: () => number;
} {
  let aborted = false;
  let addCount = 0;
  let removeCount = 0;
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener(type: string) {
      if (type !== 'abort') return;
      addCount += 1;
      // Model abort dispatch winning after the caller's first `.aborted`
      // check but before this newly-added listener becomes active. Native
      // AbortSignal does not replay an already-dispatched abort to late
      // listeners, so the listener itself is intentionally not invoked.
      aborted = true;
    },
    removeEventListener(type: string) {
      if (type === 'abort') removeCount += 1;
    },
  } as unknown as AbortSignal;

  return {
    signal,
    addCount: () => addCount,
    removeCount: () => removeCount,
  };
}

function finalExecutor(calls: ExecutionAssignment[]): DurableSegmentExecutor {
  return {
    async execute(_workerId, assignment) {
      calls.push(assignment);
      return {
        identity: assignment,
        output: { tokens: [1], text: 'ok' },
        processingTimeMs: 1,
      };
    },
  };
}

describe('DurableCoordinator AbortSignal subscription races', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not miss caller cancellation that wins during submit listener registration', async () => {
    const manifest = createFixtureModelManifest({ totalSegments: 1 });
    const repo = new InMemoryRepository();
    const calls: ExecutionAssignment[] = [];
    const coordinator = new DurableCoordinator(
      finalExecutor(calls),
      manifest,
      { allowFixtureManifest: true, maxRetries: 0 },
      repo,
    );
    coordinator.registerWorker(
      { workerId: workerId('w0'), tier: WorkerTier.TIER_3, vramMB: 8192 },
      'conn-0',
    );
    const race = abortDuringSubscriptionSignal();

    const submission = coordinator.submit('abort during subscription', { signal: race.signal });

    await expect(submission.result).rejects.toBeInstanceOf(UnzenCancelledError);
    expect(calls).toHaveLength(0);
    expect(repo.getRequest(submission.requestId)?.stage).toBe('cancelled');
    expect(race.addCount()).toBe(1);
    expect(race.removeCount()).toBe(1);
  });

  it('classifies an already-dispatched resume abort as recovery ownership loss', async () => {
    const manifest = createFixtureModelManifest({ totalSegments: 1 });
    const repo = new InMemoryRepository();
    const request: RequestRecord = {
      requestId: generateRequestId(),
      prompt: 'recover ownership race',
      stage: 'queued',
      createdAt: Date.now(),
      currentSegment: 0,
      totalSegments: 1,
      manifestDigest: manifest.manifestDigest,
      retryCount: 0,
    };
    repo.createRequest(request);

    const nativeAbortController = globalThis.AbortController;
    const resumeRace = abortDuringSubscriptionSignal();
    let controllerCount = 0;

    class SelectiveAbortController {
      readonly signal: AbortSignal;
      private readonly abortImpl: (reason?: unknown) => void;

      constructor() {
        controllerCount += 1;
        if (controllerCount === 2) {
          // startRecovery creates the first controller. runDurableRecovery
          // creates the second one for the resume handoff, which is the exact
          // classification boundary under test.
          this.signal = resumeRace.signal;
          this.abortImpl = () => {};
        } else {
          const native = new nativeAbortController();
          this.signal = native.signal;
          this.abortImpl = (reason?: unknown) => native.abort(reason);
        }
      }

      abort(reason?: unknown): void {
        this.abortImpl(reason);
      }
    }

    vi.stubGlobal('AbortController', SelectiveAbortController);

    const coordinator = new DurableCoordinator(
      finalExecutor([]),
      manifest,
      {
        allowFixtureManifest: true,
        maxRetries: 0,
        recoveryOwnershipTtlMs: 1_000,
        recoveryOwnershipRenewIntervalMs: 500,
        recoveryPollIntervalMs: 10,
      },
      repo,
    );

    const [recovery] = coordinator.recoverPendingRequests();
    expect(recovery).toBeDefined();
    await expect(recovery!.result).rejects.toMatchObject({ code: ErrorCode.StateTransitionViolation });

    // Ownership-loss cancellation must not terminalize shared durable state as
    // caller cancellation. A replacement recovery owner can still continue.
    expect(repo.getRequest(request.requestId)?.stage).toBe('queued');
    expect(resumeRace.addCount()).toBe(1);
    expect(resumeRace.removeCount()).toBe(1);
  });
});