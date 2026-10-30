import { MAX_TIMER_DELAY_MS } from './pipeline-utils.js';

/**
 * Arm an absolute deadline without ever passing an out-of-range delay to the
 * host timer. Long persisted deadlines are represented as a chain of bounded
 * timers so restart recovery preserves the original absolute deadline instead
 * of shortening legacy requests.
 *
 * Returns an idempotent cleanup function. The deadline callback is invoked at
 * most once, including when the deadline is already elapsed at arm time.
 */
export function scheduleAbsoluteDeadline(
  deadlineAt: number,
  onDeadline: () => void,
  now: () => number = Date.now,
): () => void {
  let cancelled = false;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    if (cancelled || fired) return;
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      fired = true;
      onDeadline();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };

  arm();
  return () => {
    if (cancelled) return;
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
