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

function abortError(): DOMException {
  return new DOMException('AbortError', 'AbortError');
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
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
  if (source.aborted) target.abort();
  else source.addEventListener('abort', onAbort, { once: true });
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
  const nowFn = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  for (;;) {
    if (options.signal?.aborted) throw abortError();
    const now = nowFn();
    const decision = beginDurableRecovery(repo, requestId, {
      ownerId: options.ownerId,
      now,
      ownershipTtlMs: options.ownershipTtlMs,
      maxRetries: options.maxRetries,
      manifestDigest: options.manifestDigest,
    });

    switch (decision.kind) {
      case 'missing':
        return { kind: 'missing' };
      case 'terminal':
        return { kind: 'terminal', stage: decision.stage };
      case 'owned-by-peer': {
        const waitMs = boundedWaitMs(now, options.pollIntervalMs, [decision.ownership.expiresAt]);
        await sleep(waitMs, options.signal);
        continue;
      }
      case 'wait-active-owner': {
        const waitMs = boundedWaitMs(now, options.pollIntervalMs, [
          decision.lease.expiresAt,
          decision.deadlineAt,
        ]);
        await sleep(waitMs, options.signal);
        continue;
      }
      case 'state-changed':
        // Another durable mutation won between planning and CAS. Yield before
        // replanning rather than spinning synchronously.
        await sleep(Math.min(Math.max(1, options.pollIntervalMs), 10), options.signal);
        continue;
      case 'resume-claimed': {
        const resumeController = new AbortController();
        const stopForwarding = forwardAbort(options.signal, resumeController);
        let ownershipLost = false;
        const renewEvery = Math.max(1, Math.min(
          options.ownershipRenewIntervalMs,
          Math.max(1, options.ownershipTtlMs - 1),
        ));
        const renewalTimer = setInterval(() => {
          const renewNow = nowFn();
          const claim = repo.claimRecoveryOwnership(
            {
              requestId,
              ownerId: options.ownerId,
              claimedAt: decision.ownership.claimedAt,
              expiresAt: renewNow + options.ownershipTtlMs,
            },
            renewNow,
          );
          if (claim === 'owned-by-peer') {
            ownershipLost = true;
            resumeController.abort();
          }
        }, renewEvery);

        try {
          await options.onResume({
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
          releaseDurableRecoveryOwnership(repo, requestId, options.ownerId);
        }
      }
    }
  }
}
