# WorkerPool live-view prototype fence

The guarded `WorkerInfo` views described in `worker-pool-read-ownership.md` must keep the same ordinary-object prototype as the repository-owned record.

A prototype change is a runtime trust-boundary violation even when all declared `WorkerInfo` own properties remain untouched. In particular, `currentSegment` is optional, so a hostile prototype could otherwise provide an inherited segment value and bypass the validated live-write contract.

## Rejected prototype mutation paths

Guarded views reject both JavaScript routes that can mutate the stored target prototype:

- `Object.setPrototypeOf(view, prototype)` / `Reflect.setPrototypeOf(...)`;
- assignment through the legacy `__proto__` property, including `Reflect.set(view, '__proto__', prototype)`.

The generic guarded property traps also reject defining or deleting an own `__proto__` property so the view does not acquire a second prototype-like surface.

All failures occur before the target prototype changes. `Object.getPrototypeOf(view)` continues to return `Object.prototype`, and normal WorkerPool routing/operational mutations remain unchanged.

## Regression coverage

`tests/worker-pool-prototype-fence.test.ts` verifies that direct prototype replacement and `__proto__`-based mutation fail, that no inherited `currentSegment` becomes visible, and that the worker remains available for normal routing afterward.
