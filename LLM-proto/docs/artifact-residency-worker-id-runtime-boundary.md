# ArtifactResidencyLedger worker identity runtime boundary

`ArtifactResidencyLedger` is part of the long-lived browser worker cache-residency path used by adaptive routing and span assignment. Its TypeScript APIs accept branded `WorkerId` values, but branding is compile-time only and must not be treated as a runtime trust boundary.

## Contract

Every public ledger operation that accepts a worker identity validates that identity with the shared `workerId()` authority before the identity is used for residency state lookup or mutation. The accepted runtime shape is therefore the same as other worker-facing coordinator boundaries: an actual, non-empty string. Empty/whitespace-only strings and non-string runtime values fail closed.

The validation does not change artifact or range semantics. Methods continue to perform their existing artifact/index/range checks, and valid worker IDs retain the same map identity and snapshot value. Malformed worker IDs cannot create an extra residency key, evict or clear another worker, or query residency through a non-string key.

Covered public methods include synchronization, individual/range residency mutation, eviction/clear, residency queries, byte/missing-artifact queries, and snapshots.

## Evidence boundary

This is an in-process runtime-boundary guarantee. It does not prove real browser cache persistence, physical WebGPU residency, multi-browser continuation, relay latency, or worker-loss recovery for #167, and it does not change #158 production deployment or credential requirements.
