# Split-harness evidence authority

The Coordinator, not the submitting browser payload, is authoritative for worker identity evidence.

For accepted result records:

- `segment1WorkerIdentity` is built from the worker registration that authenticated the result write.
- `segment1Role` is a convenience field only. The Coordinator overwrites any client-supplied value with `segment1WorkerIdentity.role` before storing or returning the result.
- `resumedFromCheckpoint` must still be an explicit JSON boolean and must match the authenticated role: `false` for `segment1`, `true` for `standby`.
- The immutable result digest is bound to `segment1WorkerIdentity`, including its role, generation, and profile-probe hash. A client-supplied top-level role is never trusted as digest evidence.

Consumers should treat `segment1WorkerIdentity.role` as the canonical role field. `segment1Role` exists only for compatibility/convenience and is guaranteed to mirror the canonical identity in stored Coordinator results.
