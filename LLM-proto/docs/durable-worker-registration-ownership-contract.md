# Durable worker registration ownership contract

`DurableCoordinator.registerWorker()` is a runtime trust boundary. Caller-supplied registration objects may be decoded data, accessors, or Proxies, so validation and state mutation must not repeatedly consult the caller-owned object.

## Snapshot rule

The public `DurableCoordinator` entry point reads `workerId`, `tier`, and `vramMB` exactly once and builds a fresh plain registration object. The existing durable core then performs its established protocol validation, model minimum-VRAM check, reconnect/generation handling, lease reclaim, and registry storage using only that owned snapshot.

Registration fields continue to use ordinary JavaScript property lookup, including inherited or non-enumerable declared fields. Unlike constructor options, the historical registration contract was not based on object spread; this hardening changes read ownership without introducing a new property-membership policy.

Malformed registration containers (null, arrays, primitives, functions) fail at the public boundary with the existing `protocol-violation` semantics before the durable core or worker registry can mutate state.

## Why this matters

Before this boundary was added, `DurableCoordinator` validated the caller-owned registration and then re-read `vramMB` / `workerId` before passing the same object to `WorkerRegistry`, which performed further reads. A valid-first / altered-second accessor could therefore make the value used by policy or storage differ from the value first validated.

The owned snapshot binds those stages to one set of captured values while leaving the established core validator authoritative for error messages, enum/range validation, model compatibility, and reconnect behavior.

## Evidence boundary

This change is runtime ownership / TOCTOU hardening. It does not provide new physical WebGPU, real multi-browser relay, real Llama q4 artifact, production deployment, credential, billing, or operator-authorization evidence for #167 or #158.
