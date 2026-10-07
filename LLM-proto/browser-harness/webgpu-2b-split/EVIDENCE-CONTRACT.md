# Split-harness evidence authority

The Coordinator, not the submitting browser payload, is authoritative for worker identity evidence.

For accepted result records:

- `segment0WorkerId` is a convenience field only. The Coordinator derives it from the accepted checkpoint's immutable `sourceWorkerIdentity.workerId` before storing or returning the result. An omitted incoming `segment0WorkerId` is accepted for compatibility; an explicitly supplied value must match that checkpoint identity exactly.
- The immutable result digest uses the checkpoint source worker ID, so omission and an explicitly matching `segment0WorkerId` are the same evidence and remain idempotent across retries.
- `segment1WorkerIdentity` is built from the worker registration that authenticated the result write.
- `segment1Role` is a convenience field only. The Coordinator overwrites any client-supplied value with `segment1WorkerIdentity.role` before storing or returning the result.
- `resumedFromCheckpoint` must still be an explicit JSON boolean and must match the authenticated role: `false` for `segment1`, `true` for `standby`.
- The immutable result digest is bound to `segment1WorkerIdentity`, including its role, generation, and profile-probe hash. A client-supplied top-level role is never trusted as digest evidence.
- Optional `tokenText` uses one canonical nullish representation: omission and explicit `null` are both digested and stored as `null`. Any non-null value must be an actual JSON string; arrays, objects, numbers, and booleans are rejected without coercion. Accepted strings are preserved unchanged. This keeps exported evidence shape aligned with the digest representation used for idempotency.

Consumers should treat checkpoint `sourceWorkerIdentity.workerId` as the canonical segment-0 source identity and `segment1WorkerIdentity.role` as the canonical segment-1 role. The top-level `segment0WorkerId` and `segment1Role` fields exist only for compatibility/convenience and are guaranteed to mirror their canonical identities in stored Coordinator results.
## resultDigest scope (adopted contract)

The split Coordinator adopts the **core-result digest only** contract: `resultDigest`
attests the immutable core of one accepted split run and is explicitly **not** a
digest of the entire stored result JSON record. This resolves the ambiguity tracked
in #1630 without expanding the digest to raw caller-supplied nested telemetry.

The rejected alternatives were:

- **Full accepted-evidence digest** — would require deliberate schemas and
  deterministic canonicalization for nested caller objects (`artifactCache`,
  `segmentExternalData`, `adapter`, …) before they could be digested. Hashing raw
  nested caller objects with `JSON.stringify()` would make the digest depend on
  caller property order and optional-field presence, so it is not an acceptable
  policy; that canonicalization contract does not exist yet.
- **Two digests** — a second canonical full-record/evidence digest would add a new
  surface without a current export/audit consumer to justify the compatibility
  contract.

### Fields `resultDigest` attests (digest-bound / core)

`resultDigest` is SHA-256 over exactly this projection (see `resultDigestProjection`
in `serve.mjs`), with `segment0WorkerId` and `segment1WorkerIdentity` taken from the
Coordinator-authoritative identities rather than the raw caller body:

- `checkpointId`
- `checkpointDigest`
- `checkpointSourceWorkerGeneration`
- `manifestDigest`
- `segment0WorkerId` (derived from the accepted checkpoint `sourceWorkerIdentity.workerId`)
- `segment1WorkerIdentity` (`workerId`, `role`, `generation`, `profileProbeHash`)
- `inputTokenIds`
- `boundaryBytes`
- `segment0ExecutionMs`
- `segment1ExecutionMs`
- `top1TokenId`
- `top1Logit`
- `logitsShape`
- `tokenText` (canonical nullish representation)
- `resumedFromCheckpoint`

### Coordinator-derived, not digested

Set or overwritten by the Coordinator from authenticated/route state before the
record is stored; never caller evidence and not part of the digest:

- `runId`
- `resultDigest`
- `segment1Role`
- `profileIsolationConfirmed`
- `profileIsolationEvidence`
- `storedAt`

### Supplemental / unattested

Accepted from the caller and stored verbatim. These are useful evidence/telemetry
but they are **not** attested by `resultDigest`. Any field not named in the two
lists above defaults to this classification (fail-safe for future additions):

- `schemaVersion`
- `kind`
- `status`
- `segment1WorkerId`
- `artifactCache`
- `logitsFinite`
- `logitsElementCount`
- `adapter`
- `directWorkerNetworking`
- `relayOwner`
- `artifactLayout`
- `segmentExternalData`

The overhead-free structural checks in `validateResultPayload` (for example
`status`, `relayOwner`, `directWorkerNetworking`) still fail closed, but they
constrain a field to a fixed/validated value; they do not make that field
digest-bound.

### Retry behavior

- A retry whose digest-bound projection is unchanged is idempotent (**HTTP 200**)
  and returns the first stored `resultDigest`, **even if supplemental fields differ**
  (`artifactCache`, `adapter`, `artifactLayout`, `segmentExternalData`, …). The first
  stored record is never overwritten, so the accepted core is immutable while the
  retained supplemental evidence stays as first accepted.
- A retry that changes any digest-bound field returns
  **HTTP 409 `run-result-conflict`** and the original record is unchanged.

### Consumer contract

Evidence consumers must not treat `resultDigest` as a digest of the entire stored
result record. To bind full-record evidence, consumers must hash a
canonicalization they own; `resultDigest` only binds the core projection listed
above. This keeps idempotency/replay classification independent of supplemental
telemetry churn.

This is an evidence-semantics contract only. It does not create or claim new
real-model, physical WebGPU, distinct-browser relay/latency, worker-loss/resume, or
cache-residency evidence for #167.
