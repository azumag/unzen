# Simulated prototype worker metadata ownership

`SimulatedPrototypeWorker.metadata` is exposed for contract-harness reporting, but TypeScript `readonly` alone does not prevent runtime mutation through a cast or plain JavaScript caller. The worker therefore owns an immutable metadata snapshot.

## Ownership contract

- The metadata object is frozen when the worker is constructed.
- Its initially exposed `cachedSegments` array is also frozen.
- `webgpuAdapter`, `tier`, and `vramMB` cannot be rewritten by callers after validation.
- The private `cachedSegments` Set remains the only authority for warm-cache state.
- `snapshotMetadata()` derives its sorted cache-index list from that private Set, so attempted mutation of the public metadata reference cannot forge later run reports.

This preserves existing worker tier, execution, retry, and cache semantics while making the evidence object runtime-safe rather than TypeScript-only.

## Evidence boundary

The change protects the integrity of simulated worker metadata used by the #167 contract harness. It does not provide real prepared-model, physical WebGPU, multi-browser relay, latency, or worker-loss evidence.
