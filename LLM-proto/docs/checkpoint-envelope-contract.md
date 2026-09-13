# Checkpoint envelope contract

`CheckpointStore.save()` is a runtime trust boundary. The TypeScript `Checkpoint` type does not validate values that arrive through decoded browser messages, assertions, or other untyped boundaries.

Before reading any checkpoint field or mutating resume state, the store requires the top-level checkpoint envelope to be a non-null, non-array object. `null`, `undefined`, primitives, arrays, symbols, and functions are rejected with an intentional validation error rather than falling through to incidental JavaScript property-access behavior.

After the envelope check, the existing checkpoint validation remains authoritative:

- `requestId` must be a non-empty string;
- `segmentIndex` must be a non-negative safe integer;
- `hiddenStates` must be a non-empty `Uint8Array`;
- metadata must contain a valid tensor shape, dtype, sequence length, and timestamp.

Rejected checkpoints cannot create or overwrite a resume point. Valid checkpoints retain the existing ownership-isolated snapshot behavior for hidden-state bytes and metadata shape arrays.

This is coordinator/checkpoint trust-boundary assurance only. It is not evidence of real Llama-3.2-1B q4 WebGPU execution, physical GPU memory use, multi-browser checkpoint relay, worker-loss resume, or production deployment.
