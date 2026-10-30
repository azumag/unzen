# Legacy recovery deadline compatibility

## Policy

Durable recovery preserves the original absolute deadline for requests persisted before host-timer range validation was introduced, including records whose `timeoutMs` exceeds `MAX_TIMER_DELAY_MS` (`2_147_483_647ms`).

Recovery does **not** fail-close or clamp those records. Instead, the recovered absolute `deadlineAt` is represented by a chain of host timers. Each timer is armed for at most `MAX_TIMER_DELAY_MS`; when a chunk fires before the absolute deadline, recovery recomputes the remaining duration from `Date.now()` and arms the next bounded chunk.

This keeps the persisted API contract intact while ensuring recovery never passes an out-of-range delay to `setTimeout()`.

## Lifecycle

- Normal recovered deadlines within the host range use one timer.
- An already elapsed deadline still fires immediately; the existing recovery planner normally terminalizes it before resume.
- Legacy oversized deadlines are not rewritten in storage.
- Completing, cancelling, or otherwise leaving the resumed execution cancels the currently armed chunk so it cannot re-arm later.
- New submissions remain subject to the existing `timeoutMs <= MAX_TIMER_DELAY_MS` validation; this compatibility path exists only for durable records created before that validation.

## Evidence

`tests/absolute-deadline-timer.test.ts` covers timer chaining, ordinary/elapsed deadlines, and cleanup. `tests/durable-coordinator-legacy-long-deadline-recovery.test.ts` seeds a legacy oversized `RequestRecord`, performs restart recovery, verifies the persisted timeout is unchanged, and asserts that every observed host timeout is within range.

This compatibility work is restart/recovery correctness only and is not WebGPU or multi-browser evidence for #167.
