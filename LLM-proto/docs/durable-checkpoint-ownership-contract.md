# Durable checkpoint ownership contract

Intermediate `ExecutionResult.checkpoint` values are untrusted executor-owned runtime objects. The public `DurableCoordinator.acceptResult()` boundary keeps checkpoint capture lazy, but once the intermediate branch reaches the checkpoint it detaches the envelope before the durable core performs asynchronous integrity validation or persistence.

## Payload-first capture

The snapshot preserves the core's existing copy-safety order. A malformed checkpoint container is left for the core's existing object diagnostic. For an object, `payload` is read first using normal property lookup. If that value is not a `Uint8Array`, the snapshot stops immediately so no metadata or unrelated caller getters run; the core remains authoritative for the existing payload error.

A valid payload is copied immediately into a fresh `Uint8Array`. Digest validation, TTL checks, cancellation/lease rechecks, and repository persistence therefore operate on bytes that can no longer be mutated through the executor-owned buffer after capture.

## Declared metadata only

The previous core copy used object spread, which enumerated the complete caller object and could execute unrelated enumerable getters. The public snapshot instead performs targeted reads for only the declared checkpoint metadata fields. Metadata keeps the legacy spread membership rule: only own-enumerable declared fields are copied. The optional `previousCheckpointDigest` property retains whether it was present as an own-enumerable property.

Each participating declared field is read once. Unknown properties are neither enumerated nor read, and the durable core subsequently sees only the fresh plain checkpoint envelope. Its existing identity, digest, payload-length, size, format, TTL, conflict, cancellation-race, and storage rules remain authoritative.

The core may still copy/spread this owned plain envelope internally; those later operations no longer invoke executor-owned getters or Proxy enumeration.

## Evidence boundary

This is runtime ownership / TOCTOU hardening. It is not new physical WebGPU, real multi-browser relay, Llama q4 artifact, production deployment, credential, billing, or operator-authorization evidence for #167 or #158.
