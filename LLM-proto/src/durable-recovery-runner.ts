/**
 * Bounded orchestration around the repository-backed durable recovery command.
 *
 * This layer turns `owned-by-peer` / `wait-active-owner` into waits bounded by
 * the persisted ownership/lease expiry and original request deadline. When a
 * request becomes resumable it retains and renews the recovery claim until the
 * caller has established durable execution ownership.
 */

import {
  beginDurableRecovery,
  releaseDurableRecoveryOwnership,
} from './durable-recovery-command.js';
import type { RecoveryOwnership } from './durable-repository.js';
import type { DurableRepository } from './durable-repository.js';
import { ErrorCode, UnzenError } from './errors.js';
import type { CheckpointEnvelope } from './checkpoint-envelope.js';
import { MAX_TIMER_DELAY_MS } from './pipeline-utils.js';
import type { InferenceRequestId } from './types.js';

export interface DurableRecoveryResumeContext {
  readonly requestId: InferenceRequestId;
  readonly segmentIndex: number;
  readonly checkpoint?: CheckpointEnvelope;
  readonly deadlineAt?: number;
  readonly ownership: RecoveryOwnership;
  /** Aborted if the caller aborts recovery or ownership is lost while resuming. */
  readonly signal: AbortSignal;
}

export interface DurableRecoveryRunnerOptions {
  readonly ownerId: string;
  readonly ownershipTtlMs: number;
  readonly ownershipRenewIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly maxRetries: number;
  readonly manifestDigest: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  /**
   * Must not return until durable execution ownership is established (for
   * example, an execution lease/epoch has been installed) or the request has
   * reached a terminal state.
   */
  readonly onResume: (context: DurableRecoveryResumeContext) => Promise<void>;
}

export type DurableRecoveryRunnerResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'terminal'; readonly stage: 'completed' | 'failed' | 'cancelled' }
  | { readonly kind: 'resumed'; readonly requestId: InferenceRequestId; readonly segmentIndex: number };

function snapshotRecoveryRunnerOptions(
  options: DurableRecoveryRunnerOptions,
): DurableRecoveryRunnerOptions {
  const ownerId = options.ownerId;
  const ownershipTtlMs = options.ownershipTtlMs;
  const ownershipRenewIntervalMs = options.ownershipRenewIntervalMs;
  const pollIntervalMs = options.pollIntervalMs;
  const maxRetries = options.maxRetries;
  const manifestDigest = options.manifestDigest;
  const now = options.now;
  const sleep = options.sleep;
  const signal = options.signal;
  const onResume = options.onResume;

  for (const [field, value] of [
    ['ownershipRenewIntervalMs', ownershipRenewIntervalMs],
    ['pollIntervalMs', pollIntervalMs],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`Durable recovery ${field} must be a non-negative finite number`);
    }
    if (value > MAX_TIMER_DELAY_MS) {
      throw new RangeError(
        `Durable recovery ${field} must not exceed ${MAX_TIMER_DELAY_MS}ms`,
      );
    }
  }

  if (signal !== undefined) {
    if (typeof signal !== 'object' || signal === null || Array.isArray(signal)) {
      throw new TypeError('Durable recovery signal must be an AbortSignal-compatible object');
    }
    const signalCandidate = signal as unknown as Record<string, unknown>;
    if (
      typeof signalCandidate.aborted !== 'boolean'
      || typeof signalCandidate.addEventListener !== 'function'
      || typeof signalCandidate.removeEventListener !== 'function'
    ) {
      throw new TypeError(
        'Durable recovery signal must expose boolean aborted and event-listener methods',
      );
    }
  }

  return Object.freeze({
    ownerId,
    ownershipTtlMs,
    ownershipRenewIntervalMs,
    pollIntervalMs,
    maxRetries,
    manifestDigest,
    now,
    sleep,
    signal,
    onResume,
  });
}

function abortError(): DOMException {
  return new DOMException('AbortError', 'AbortError');
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = () => finish(() => reject(abortError()));

    timer = setTimeout(() => finish(resolve), Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });

    // Close the check-then-listen race: if the signal flipped after the
    // initial aborted check but before listener registration became active,
    // the event may already have been dispatched and would otherwise be lost.
    if (signal?.aborted) onAbort();
  });
}

function boundedWaitMs(
  now: number,
  pollIntervalMs: number,
  deadlines: readonly (number | undefined)[],
): number {
  let wait = Math.max(0, pollIntervalMs);
  for (const deadline of deadlines) {
    if (deadline === undefined) continue;
    wait = Math.min(wait, Math.max(0, deadline - now));
  }
  return wait;
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const onAbort = () => target.abort();
  if (source.aborted) {
    onAbort();
    return () => {};
  }

  source.addEventListener('abort', onAbort, { once: true });
  // As with the wait helper, an abort can win between the first state check
  // and listener registration. Re-check after subscribing so the target
  // cannot remain live after caller cancellation.
  if (source.aborted) onAbort();
  return () => source.removeEventListener('abort', onAbort);
}

/**
 * Recover one persisted request until it is terminal, missing, or handed back
 * to durable execution ownership.
 *
 * No wait is unbounded by persisted state: peer recovery waits observe the
 * peer claim expiry; execution-owner waits observe lease expiry; both also
 * honor the original request deadline when present. The small poll interval is
 * only for noticing an earlier terminal/result transition.
 */
export async function runDurableRecovery(
  repo: DurableRepository,
  requestId: InferenceRequestId,
  options: DurableRecoveryRunnerOptions,
): Promise<DurableRecoveryRunnerResult> {
  // A recovery lifecycle spans awaits and renewal callbacks. Own all consumed
  // caller configuration before entering that lifecycle so getter/Proxy-backed
  // input cannot change owner identity, timing, abort, or callback semantics
  // after a claim has been established.
  const ownedOptions = snapshotRecoveryRunnerOptions(options);
  const nowFn = ownedOptions.now ?? Date.now;
  const sleep = ownedOptions.sleep ?? defaultSleep;

  for (;;) {
    if (ownedOptions.signal?.aborted) throw abortError();
    const now = nowFn();
    const decision = beginDurableRecovery(repo, requestId, {
      ownerId: ownedOptions.ownerId,
      now,
      ownershipTtlMs: ownedOptions.ownershipTtlMs,
      maxRetries: ownedOptions.maxRetries,
      manifestDigest: ownedOptions.manifestDigest,
    });

    switch (decision.kind) {
      case 'missing':
        return { kind: 'missing' };
      case 'terminal':
        return { kind: 'terminal', stage: decision.stage };
      case 'owned-by-peer': {
        const waitMs = boundedWaitMs(now, ownedOptions.pollIntervalMs, [decision.ownership.expiresAt]);
        await sleep(waitMs, ownedOptions.signal);
        continue;
      }
      case 'wait-active-owner': {
        const waitMs = boundedWaitMs(now, ownedOptions.pollIntervalMs, [
          decision.lease.expiresAt,
          decision.deadlineAt,
        ]);
        await sleep(waitMs, ownedOptions.signal);
        continue;
      }
      case 'state-changed':
        // Another durable mutation won between planning and CAS. Yield before
        // replanning rather than spinning synchronously.
        await sleep(Math.min(Math.max(1, ownedOptions.pollIntervalMs), 10), ownedOptions.signal);
        continue;
      case 'resume-claimed': {
        const resumeController = new AbortController();
        const stopForwarding = forwardAbort(ownedOptions.signal, resumeController);
        let ownershipLost = false;
        const renewEvery = Math.max(1, Math.min(
          ownedOptions.ownershipRenewIntervalMs,
          Math.max(1, ownedOptions.ownershipTtlMs - 1),
        ));
        const renewalTimer = setInterval(() => {
          const renewNow = nowFn();
          const claim = repo.claimRecoveryOwnership(
            {
              requestId,
              ownerId: ownedOptions.ownerId,
              claimedAt: decision.ownership.claimedAt,
              expiresAt: renewNow + ownedOptions.ownershipTtlMs,
            },
            renewNow,
          );
          if (claim === 'owned-by-peer') {
            ownershipLost = true;
            resumeController.abort();
          }
        }, renewEvery);

        try {
          await ownedOptions.onResume({
            requestId,
            segmentIndex: decision.segmentIndex,
            checkpoint: decision.checkpoint,
            deadlineAt: decision.deadlineAt,
            ownership: decision.ownership,
            signal: resumeController.signal,
          });
          if (ownershipLost) {
            throw new UnzenError(
              `durable recovery ownership lost for ${requestId}`,
              ErrorCode.StateTransitionViolation,
            );
          }
          return {
            kind: 'resumed',
            requestId,
            segmentIndex: decision.segmentIndex,
          };
        } finally {
          clearInterval(renewalTimer);
          stopForwarding();
          releaseDurableRecoveryOwnership(repo, requestId, ownedOptions.ownerId);
        }
      }
    }
  }
}
