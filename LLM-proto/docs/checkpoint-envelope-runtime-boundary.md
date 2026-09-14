# Checkpoint envelope runtime boundary

`validateCheckpointEnvelope()` is an exported runtime trust boundary. TypeScript types are not treated as proof that an envelope or expected comparison object is stable, plain, or immutable.

The validator therefore follows these rules:

- caller-owned envelope metadata is read once in the existing fail-fast structural order;
- identity, segment, worker/generation, model revision, format, byte budget, TTL, and digest checks use captured values rather than re-reading accessors or Proxy-backed properties;
- the expected comparison fields are also read once at the stage where each comparison is performed;
- caller objects are not spread or enumerated, so unknown enumerable getters and `ownKeys` traps are outside the validation path;
- the configured payload ceiling is validated and enforced before allocating the defensive payload copy;
- after structure, identity, byte-budget, and TTL eligibility have succeeded, payload bytes are copied into an owned `Uint8Array` before the first asynchronous digest yield;
- SHA-256 validation is performed against that owned copy, so later caller mutation cannot alter the authenticated bytes;
- the pre-existing public `CheckpointValidationResult` failure messages and fail-fast ordering remain the compatibility contract.

This hardening is local to checkpoint validation. It does not change checkpoint formats, manifest policy, retry/resume policy, artifact policy, production deployment state, or the evidence requirements tracked by #167 and #158.
