# Checkpoint envelope runtime boundary

`createCheckpointEnvelope()`, `validateCheckpointEnvelope()`, `verifyCheckpointDigest()`, and `sha256Hex()` are exported runtime trust boundaries. TypeScript types are not treated as proof that an input or envelope is stable, plain, immutable, or backed by genuine typed-array internal slots.

All checkpoint byte operations first require a genuine `Uint8Array` view. A `Proxy` around a `Uint8Array` may satisfy `instanceof Uint8Array` while lacking TypedArray internal slots, so Proxy-backed byte payloads are rejected before any native typed-array getter/copy operation. Genuine `Uint8Array` subclasses remain accepted, but byte length is read through the intrinsic TypedArray getter and bytes are copied with the intrinsic `Uint8Array.prototype.set`, bypassing caller-defined `byteLength`, iterator, `slice()`, or species hooks.

`createCheckpointEnvelope()` owns the checkpoint bytes at creation time:

- caller-owned `payload` is read once;
- malformed runtime payloads are rejected before SHA-256 work;
- the actual payload byte length is captured through the intrinsic TypedArray getter;
- the captured bytes are copied to a fresh owned base `Uint8Array` before the first asynchronous digest yield;
- SHA-256 is computed directly over that owned byte snapshot;
- the returned `payloadLength`, `payloadDigest`, and `payload` all describe the same owned bytes;
- later mutation of the caller's original buffer cannot mutate or invalidate the newly created envelope;
- caller input objects are not spread or enumerated;
- non-payload metadata/default reads retain their existing post-digest observation timing.

`validateCheckpointEnvelope()` follows these rules:

- caller-owned envelope metadata is read once in the existing fail-fast structural order;
- identity, segment, worker/generation, model revision, format, byte budget, TTL, and digest checks use captured values rather than re-reading accessors or Proxy-backed properties;
- payload validity and actual byte length are established through intrinsic typed-array operations without allocating a defensive copy;
- the expected comparison fields are also read once at the stage where each comparison is performed;
- caller objects are not spread or enumerated, so unknown enumerable getters and `ownKeys` traps are outside the validation path;
- the configured payload ceiling is validated and enforced before allocating the defensive payload copy;
- after structure, identity, byte-budget, and TTL eligibility have succeeded, payload bytes are copied with the intrinsic setter into an owned base `Uint8Array` before the first asynchronous digest yield;
- SHA-256 validation is performed against that owned copy, so later caller mutation cannot alter the authenticated bytes;
- the pre-existing public `CheckpointValidationResult` failure messages and fail-fast ordering remain the compatibility contract.

`verifyCheckpointDigest()` independently enforces the same ownership principle for its narrower boolean API:

- `payload`, actual payload byte length, declared `payloadLength`, and `payloadDigest` are captured in validation order;
- malformed values, Proxy-backed typed arrays, or throwing scoped getters fail closed with `false`;
- caller objects are not spread or enumerated;
- byte-length validation uses the intrinsic length captured from the payload rather than a caller-defined property;
- eligible bytes are copied to a fresh owned base `Uint8Array` before the asynchronous SHA-256 digest boundary;
- digest comparison uses only the captured digest and owned bytes, so later caller mutation or alternate accessor values cannot change what is authenticated.

`sha256Hex()` applies the same genuine-view and intrinsic-copy rules before hashing. Malformed runtime byte arguments fail with an intentional `TypeError` rather than a native TypedArray internal-slot exception.

This hardening is local to checkpoint creation/validation. It does not change checkpoint formats, manifest policy, retry/resume policy, artifact policy, production deployment state, or the evidence requirements tracked by #167 and #158.
