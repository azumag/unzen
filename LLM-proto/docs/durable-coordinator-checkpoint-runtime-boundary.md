# DurableCoordinator checkpoint runtime boundary

`DurableCoordinator` treats executor-supplied checkpoint envelopes as hostile runtime input before they reach the authoritative checkpoint validator.

The wrapper preserves the existing checkpoint policy while bounding JavaScript operations that can execute caller code or throw native exceptions:

- the checkpoint container is classified without allowing a revoked `Proxy` to escape through `Array.isArray()`;
- `payload` is read once and a throwing getter fails closed before any metadata is inspected;
- `payload instanceof Uint8Array` is guarded so a revoked payload `Proxy` cannot leak a native exception;
- declared own-enumerable metadata is inspected without `ownKeys`/iteration;
- `Object.getOwnPropertyDescriptor()` and the subsequent single field read are both guarded;
- an inaccessible declared field is represented as present-but-invalid input for the core validator, rather than being treated as absent;
- this is especially important for optional `previousCheckpointDigest`: a throwing descriptor/getter cannot erase a supplied chain claim;
- caught caller values are never stringified or coerced.

The payload-first ordering remains intentional. If the payload is malformed or inaccessible, metadata getters are not touched. Genuine `Uint8Array` bytes are also not copied by the wrapper: the core remains responsible for enforcing `maxCheckpointBytes` before ownership allocation and for taking the synchronous byte snapshot used by async digest validation.

The core `validateCheckpointEnvelope()` contract remains authoritative for rejection messages and checkpoint integrity policy. This wrapper only converts inaccessible runtime surfaces into deterministic malformed input so native/caller exceptions do not cross the public `DurableCoordinator` boundary.

Regression coverage lives in `tests/durable-coordinator-checkpoint-hostile-boundary.test.ts` and the existing `tests/durable-coordinator-checkpoint-ownership.test.ts`.

This is runtime trust-boundary hardening only. It is not new real-model, physical WebGPU, multi-browser relay/latency, worker-loss/resume, measured residency, deployment, or billing evidence for #167.
