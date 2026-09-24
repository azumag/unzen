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