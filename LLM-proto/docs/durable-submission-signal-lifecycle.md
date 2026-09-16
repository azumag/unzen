# Durable submission AbortSignal lifecycle

`DurableCoordinator.submit()` treats a caller-provided `AbortSignal` as a live cancellation source, but it must not let caller-controlled signal methods or getters mutate durable state indirectly.

The public coordinator boundary now separates the signal lifecycle into three phases:

1. Capture and validate the top-level submission fields and the structural AbortSignal surface before durable mutation.
2. Preserve the existing-idempotency fast path without attaching a new caller listener. For a genuinely new submission, subscribe the caller signal first and forward cancellation through a coordinator-owned `AbortController` signal.
3. Pass only that stable owned signal into the durable core. Caller listener removal is best-effort and runs after request settlement; cleanup failures cannot replace the request result or keep the core `inFlight` entry alive.

The bridge keeps the normal check → subscribe → re-check ordering. If the caller signal aborts during registration, the owned signal is aborted before the core begins execution. If `addEventListener()` throws, or the live `aborted` state becomes unreadable/non-boolean after subscription, the bridge is cleaned up and submission fails before idempotency binding or request creation.

A concurrent idempotency winner is also bounded. The bridge records whether the durable core actually subscribed to it. When the core returns an already-existing request before subscribing, the speculative caller listener is removed immediately rather than being retained for the existing request lifetime.

This boundary intentionally does not make a duplicate caller signal authoritative over an already-existing durable request. It also does not change recovery signal handling, persisted deadline policy (#877), production deployment (#158), or the real WebGPU/multi-browser evidence requirements in #167.
