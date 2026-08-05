/**
 * Durable request state machine (issue #103).
 *
 * The issue mandates a validated transition graph:
 *
 *   accepted → queued → leased → running → completed
 *   queued / leased / running / retry-wait → cancelled
 *   leased / running → failed
 *   running → retry-wait → queued
 *
 * Two scheduling edges are added beyond the issue's minimal list so a request
 * can FAIL while waiting to be scheduled: `queued → failed` (no worker
 * available within the retry/deadline budget) and `retry-wait → failed`
 * (deadline expired during backoff). Without these, a request that could never
 * be scheduled would be stuck in `queued` until an unrelated cancellation.
 *
 * One more edge is needed for multi-segment runs: `running → queued`. After a
 * non-final segment commits its checkpoint, the request returns to the
 * scheduling queue to await the next segment's lease (queued → leased →
 * running again). The stage is REQUEST-level: it reflects which execution unit
 * is currently scheduled/running, so the per-segment sequence repeats until
 * the final segment commits to `completed`.
 *
 * Late updates from terminal states (completed / failed / cancelled) are
 * rejected: a duplicated or stale completion arriving after the request
 * already terminated must never mutate state. This is the single source of
 * truth consumed by the Coordinator's transition commands.
 */

// The full stage set. Order is not meaningful; kept as an array for the
// exhaustive property tests and for repository-backed serialization checks.
export const REQUEST_STAGES = [
  'accepted',
  'queued',
  'leased',
  'running',
  'retry-wait',
  'completed',
  'failed',
  'cancelled',
] as const;

export type RequestStage = (typeof REQUEST_STAGES)[number];

export const TERMINAL_STAGES: readonly RequestStage[] = ['completed', 'failed', 'cancelled'];

/** Adjacency table: only the transitions the issue mandates are allowed. */
const TRANSITIONS: Readonly<Record<RequestStage, readonly RequestStage[]>> = {
  accepted: ['queued'],
  queued: ['leased', 'failed', 'cancelled'],
  leased: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'retry-wait', 'queued', 'cancelled'],
  'retry-wait': ['queued', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/** True when moving from `from` to `to` is a validated transition. */
export function isLegalTransition(from: RequestStage, to: RequestStage): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Error thrown when an illegal transition is commanded. */
export class TransitionCommandError extends Error {
  constructor(from: RequestStage, to: RequestStage) {
    super(`Illegal state transition: ${from} → ${to} is not allowed`);
    this.name = 'TransitionCommandError';
  }
}

/** Validate a transition command; throws on illegal (late/duplicate) moves. */
export function assertLegalTransition(from: RequestStage, to: RequestStage): void {
  if (!isLegalTransition(from, to)) {
    throw new TransitionCommandError(from, to);
  }
}

/**
 * Apply a validated transition and return the new stage.
 * Functional reducer: does not mutate the input stage, so a failed command
 * can never leave partially-mutated state behind.
 */
export function applyTransition(from: RequestStage, to: RequestStage): RequestStage {
  assertLegalTransition(from, to);
  return to;
}
