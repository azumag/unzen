# Checkpoint repository isolation

`DurableRepository` treats a successfully stored `CheckpointEnvelope` as repository-owned state. This contract is explicit in both `InMemoryRepository` and `DurableObjectRepository`; correctness does not depend on whether the backing storage happens to structured-clone values.

## Write boundary

`putCheckpoint()` first captures only the fields needed to identify and classify a checkpoint slot: `requestId`, `segmentIndex`, and `payloadDigest`. If the `(requestId, segmentIndex)` slot is already occupied, the existing `unchanged` / `conflict` decision is returned from those captured fields without reading or copying the incoming payload or unrelated metadata.

For a new slot, the remaining envelope fields are captured once into a plain repository-owned record. The mutable `Uint8Array` payload is copied byte-by-byte by index into a fresh array; the caller object is not enumerated and payload iteration hooks are not used. The key and persisted digest come from the same identity snapshot that was used for slot classification.

This is an ownership boundary, not a second validation layer. Checkpoint identity, digest, size, TTL, and model compatibility continue to be validated at the checkpoint/Coordinator boundary before persistence.

## Read boundary

`getCheckpoint()`, `listCheckpoints()`, `allCheckpoints()`, and `collectExpiredCheckpoints()` return detached envelope records with fresh payload arrays. Mutating a returned record or payload therefore cannot rewrite repository state or another read result.

The same rules apply to the in-memory test/reference adapter and the Durable Object adapter, including when the latter is exercised against reference-preserving storage.

## Evidence scope

The regression suite uses reference-preserving KV storage to prove retained write inputs, direct reads, list reads, global reads, and expired-checkpoint returns cannot mutate persisted checkpoint state, and that occupied-slot short circuits do not consume payload/unrelated fields.

This hardens runtime/durability semantics only. It is not evidence for real `Llama-3.2-1B-Instruct` q4 artifact sizing, physical WebGPU memory use, real-model full-vs-multi equivalence, real multi-browser checkpoint relay/latency, worker-loss resume, or production deployment. Issue #158 remains on HOLD.
