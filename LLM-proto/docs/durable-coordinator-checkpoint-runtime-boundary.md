# DurableCoordinator checkpoint runtime boundary

`DurableCoordinator` treats executor-supplied checkpoint envelopes as hostile runtime input before they reach the authoritative checkpoint validator.

The wrapper preserves the existing checkpoint policy while bounding JavaScript operations that can execute caller code or throw native exceptions:

- the checkpoint container is classified without allowing a revoked `Proxy` to escape through `Array.isArray()`;
- `payload` is read once and a throwing getter fails closed before any metadata is inspected;
- live or revoked `Proxy` wrappers around typed arrays are rejected before the core can touch typed-array accessors;
- genuine `Uint8Array` instances and subclasses are normalized into a plain zero-copy view using intrinsic typed-array `buffer`, `byteOffset`, and `byteLength` getters, so caller-defined subclass accessors cannot run in the core;
- declared own-enumerable metadata is inspected without `ownKeys`/iteration;
- `Object.getOwnPropertyDescriptor()` and the subsequent single field read are both guarded;
- an inaccessible declared field is represented as present-but-invalid input for the core validator, rather than being treated as absent;
- this is especially important for optional `previousCheckpointDigest`: a throwing descriptor/getter cannot erase a supplied chain claim;
- caught caller values are never stringified or coerced.

The payload-first ordering remains intentional. If the payload is malformed or inaccessible, metadata getters are not touched. The wrapper creates only a view over the original backing bytes; it does not copy checkpoint bytes. The core remains responsible for enforcing `maxCheckpointBytes` before the first byte-copy allocation and for taking the synchronous owned byte snapshot used by async digest validation.

The core `validateCheckpointEnvelope()` contract remains authoritative for rejection messages and checkpoint integrity policy. This wrapper only converts inaccessible runtime surfaces into deterministic malformed input so native/caller exceptions do not cross the public `DurableCoordinator` boundary.

Regression coverage lives in `tests/durable-coordinator-checkpoint-hostile-boundary.test.ts` and the existing `tests/durable-coordinator-checkpoint-ownership.test.ts`.

This is runtime trust-boundary hardening only. It is not new real-model, physical WebGPU, multi-browser relay/latency, worker-loss/resume, measured residency, deployment, or billing evidence for #167.
