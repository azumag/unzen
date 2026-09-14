# Checkpoint envelope runtime boundary

`createCheckpointEnvelope()`, `validateCheckpointEnvelope()`, and `verifyCheckpointDigest()` are exported runtime trust boundaries. TypeScript types are not treated as proof that an input or envelope is stable, plain, or immutable.

`createCheckpointEnvelope()` owns the checkpoint bytes at creation time:

- caller-owned `payload` is read once;
- malformed runtime payloads are rejected before SHA-256 work;
- the captured bytes are copied to a fresh owned `Uint8Array` before the first asynchronous digest yield;
- SHA-256 is computed directly over that owned byte snapshot;
- the returned `payloadLength`, `payloadDigest`, and `payload` all describe the same owned bytes;
- later mutation of the caller's original buffer cannot mutate or invalidate the newly created envelope;
- caller input objects are not spread or enumerated;
- non-payload metadata/default reads retain their existing post-digest observation timing.

`validateCheckpointEnvelope()` follows these rules:

- caller-owned envelope metadata is read once in the existing fail-fast structural order;
- identity, segment, worker/generation, model revision, format, byte budget, TTL, and digest checks use captured values rather than re-reading accessors or Proxy-backed properties;
- the expected comparison fields are also read once at the stage where each comparison is performed;
- caller objects are not spread or enumerated, so unknown enumerable getters and `ownKeys` traps are outside the validation path;
- the configured payload ceiling is validated and enforced before allocating the defensive payload copy;
- after structure, identity, byte-budget, and TTL eligibility have succeeded, payload bytes are copied into an owned `Uint8Array` before the first asynchronous digest yield;
- SHA-256 validation is performed against that owned copy, so later caller mutation cannot alter the authenticated bytes;
- the pre-existing public `CheckpointValidationResult` failure messages and fail-fast ordering remain the compatibility contract.

`verifyCheckpointDigest()` independently enforces the same ownership principle for its narrower boolean API:

- `payload`, `payloadLength`, and `payloadDigest` are each captured at most once in validation order;
- malformed values or throwing scoped getters fail closed with `false`;
- caller objects are not spread or enumerated;
- byte-length validation uses the captured payload and length;
- eligible bytes are copied to a fresh owned `Uint8Array` before the asynchronous SHA-256 digest boundary;
- digest comparison uses only the captured digest and owned bytes, so later caller mutation or alternate accessor values cannot change what is authenticated.

This hardening is local to checkpoint creation/validation. It does not change checkpoint formats, manifest policy, retry/resume policy, artifact policy, production deployment state, or the evidence requirements tracked by #167 and #158.
