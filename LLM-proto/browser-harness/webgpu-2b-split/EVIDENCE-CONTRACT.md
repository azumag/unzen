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

## Result digest authority

`resultDigest` is a core-result digest, not a digest of the stored result record. It attests exactly the immutable run result that `resultDigestFor()` projects:

- `checkpointId`, `checkpointDigest`, `checkpointSourceWorkerGeneration`
- `manifestDigest`
- `segment0WorkerId` (Coordinator-derived from the accepted checkpoint)
- `segment1WorkerIdentity` (`workerId`, `role`, `generation`, `profileProbeHash`)
- `inputTokenIds`, `boundaryBytes`
- `segment0ExecutionMs`, `segment1ExecutionMs`
- `top1TokenId`, `top1Logit`, `logitsShape`
- `tokenText` (canonical `null` for omitted/explicit null)
- `resumedFromCheckpoint`

Every other stored field is classified in `RESULT_DIGEST_AUTHORITY` (`serve.mjs`), and the authority test keeps that classification in sync with the hashed projection:

- **Coordinator-derived** — written by the Coordinator, never trusted from the client payload: `runId`, `resultDigest`, `segment0WorkerId`, `segment1Role`, `segment1WorkerIdentity`, `profileIsolationConfirmed`, `profileIsolationEvidence`, `storedAt`.
- **Supplemental / unattested** — client-reported telemetry stored verbatim but deliberately outside the digest: `schemaVersion`, `kind`, `segment1WorkerId`, `artifactCache`, `adapter`, `logitsFinite`, `logitsElementCount`, `artifactLayout`, `segmentExternalData`. They are useful evidence about how the run was produced, but they are not part of the result identity.
- **Validated gate** — mandatory fixed-value fields checked before any result state exists: `status`, `relayOwner`, `directWorkerNetworking`. A differing value is rejected with HTTP 400, so binding them into the digest would add nothing.

Retry semantics for supplemental fields are explicit: an HTTP retry that differs only in supplemental fields keeps the same `resultDigest`, is answered `200` with `idempotent: true`, and the first stored record is not replaced. The originally stored supplemental values therefore remain the exported evidence for that run; a later conflicting submission neither overwrites them nor changes the result identity. Only a change to a digest-bound field produces `409 run-result-conflict`.

Evidence consumers must not treat `resultDigest` as a digest of the full stored JSON record, and must not re-derive it from raw nested caller objects. Supplemental values are attested only by their presence in the stored record plus the surrounding run binding; no raw nested object is hashed with `JSON.stringify()` under a caller-controlled key order.
