# WorkerPool worker identity runtime boundary

The legacy `WorkerPool` accepts branded `WorkerId` values, but TypeScript branding is not a runtime trust boundary. Decoded or asserted runtime data can still carry empty, whitespace-only, or non-string identities.

## Contract

Every public `WorkerPool` operation that uses a worker identity for map lookup or mutation validates that identity with the shared `workerId()` authority first:

- `unregister()`
- `heartbeat()`
- `markBusy()`
- `markIdle()`
- `markDisconnected()`
- `get()`

Valid but unknown worker IDs preserve the existing method-specific behavior: `false`, `undefined`, or a no-op as applicable. `markBusy()` also preserves its existing fail-fast ordering by validating the segment index before validating the worker ID.

Worker registration remains protected by the registration-container and field validators; this boundary closes the direct lookup/mutation path after registration.

## Evidence boundary

This is an in-process legacy routing guarantee. It does not establish real browser/WebGPU capability, artifact residency, multi-browser continuation, relay latency, or worker-loss recovery evidence for #167, and it does not change #158 production deployment, credentials, billing, or HOLD status.
