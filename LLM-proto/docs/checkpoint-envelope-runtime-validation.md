# Checkpoint envelope runtime validation

`CheckpointEnvelope` crosses worker, Coordinator, durable-storage, and resume boundaries, so its TypeScript interface is not treated as proof of runtime shape.

Before `validateCheckpointEnvelope()` compares the envelope with the active lease/run context or hashes hidden-state bytes, it rejects structurally malformed values. A valid envelope requires:

- non-empty string `requestId`, `attemptId`, `workerId`, `workerGeneration`, and `formatVersion`;
- a non-negative JavaScript safe-integer `segmentIndex`;
- a runtime `Uint8Array` payload;
- a non-negative safe-integer `payloadLength` equal to the actual payload byte length;
- canonical 64-character lowercase hexadecimal SHA-256 values for `modelManifestDigest` and `payloadDigest`, and for `previousCheckpointDigest` when present.

Malformed envelopes return the existing checkpoint-integrity mismatch result before `crypto.subtle.digest()` runs. `verifyCheckpointDigest()` also returns `false` rather than throwing when the runtime payload or digest metadata is malformed.

This validation is a Coordinator trust-boundary guarantee only. It does not constitute evidence for real 1B WebGPU execution, real network relay latency, multi-browser continuation, or worker-loss resume. Production deployment evidence remains separate.
