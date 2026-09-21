# Checkpoint envelope contract

`CheckpointStore.save()` is a runtime trust boundary. The TypeScript `Checkpoint` type does not validate values that arrive through decoded browser messages, assertions, or other untyped boundaries.

Before reading any checkpoint field or mutating resume state, the store requires the top-level checkpoint envelope to be a non-null, non-array object. `null`, `undefined`, primitives, arrays, symbols, and functions are rejected with an intentional validation error rather than falling through to incidental JavaScript property-access behavior.

After the envelope check, the existing checkpoint validation remains authoritative:

- `requestId` must be a non-empty string;
- `segmentIndex` must be a non-negative safe integer;
- `hiddenStates` must be a non-empty genuine `Uint8Array` view;
- metadata must contain a valid tensor shape, dtype, sequence length, and timestamp.

The hidden-state validation checks the platform's `ArrayBuffer.isView()` authority before it performs any typed-array operation. A `Proxy` around a `Uint8Array` can satisfy `instanceof Uint8Array` while lacking TypedArray internal slots, so Proxy-backed payloads are rejected with the checkpoint domain validation error rather than leaking a native `TypeError`. Genuine `Uint8Array` instances and subclasses remain accepted, but the boundary immediately copies them through the intrinsic `Uint8Array` constructor. This normalizes the owned bytes to a base `Uint8Array` before checking `byteLength` or taking later snapshots, so caller-defined subclass getters, `slice()` methods, or species behavior are not executed by the trust boundary.

`save()` treats validation and persistence as one ownership boundary. Each consumed top-level checkpoint field and metadata field is captured once. The metadata shape membership is captured by index and validated from those same values. The request ID and segment index used for the store bucket/key are exactly the values that passed validation, so an accessor or Proxy cannot validate under one identity and persist under a later re-read identity. The captured hidden-state bytes and shape are copied into store-owned state before the checkpoint is retained.

Public `CheckpointStore.assertValidCheckpoint()` uses the same capture-and-validation authority but does not persist or retain its temporary capture. This keeps Pipeline/SpanPipeline validation semantics aligned with `save()` without changing the accepted checkpoint policy.

Rejected checkpoints cannot create or overwrite a resume point. Valid checkpoints retain the existing ownership-isolated snapshot behavior for hidden-state bytes and metadata shape arrays, including isolation from caller mutation after `save()` and from mutation of values returned by `get()`/`latest()`.

This is coordinator/checkpoint trust-boundary assurance only. It is not evidence of real Llama-3.2-1B q4 WebGPU execution, physical GPU memory use, multi-browser checkpoint relay, worker-loss resume, or production deployment.
