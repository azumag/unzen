# Durable cancellation request-ID runtime boundary

Issue #551 hardens `DurableCoordinator.cancel()` at the transport/API boundary.

## Contract

`cancel(requestId)` treats the runtime value as untrusted even when TypeScript has branded it as `InferenceRequestId`.

Before any durable request lookup, cancellation tombstone write, lease/attempt mutation, diagnostic interpolation, or local abort, the Coordinator requires `requestId` to be an actual non-empty string. Empty and whitespace-only strings are rejected. Accepted strings keep their exact identity; the Coordinator does not trim or canonicalize them.

Malformed values fail closed with `ErrorCode.ProtocolViolation`. This includes `null`, `undefined`, primitives other than strings, arrays, objects, `Symbol`, empty strings, and whitespace-only strings. A valid non-empty string that does not identify a durable request retains the existing `ErrorCode.RequestNotFound` behavior.

## State-safety guarantee

A malformed cancellation request ID must not create a cancellation record or change an existing request, active lease, attempt record, worker state, or suppression record. Validation therefore occurs before repository access on the cancellation path.

The normal cancellation policy is unchanged for valid IDs: active cancellation is persisted before local abort/lease invalidation, terminal completed/failed requests retain their structured dispositions, repeated cancellation retains the existing acknowledgement semantics, and accepted string identity is preserved byte-for-byte.

## Evidence scope

The focused regression test exercises malformed runtime values, verifies durable request/lease/attempt/worker state remains unchanged, preserves `RequestNotFound` for a valid unknown ID, and verifies an accepted padded string is not trimmed.

This is runtime protocol hardening only. It is not new evidence for real Llama-3.2-1B q4 WebGPU execution, physical GPU working-set measurements, real multi-browser checkpoint relay, or worker-loss resume in #167, and it does not change the production/deployment HOLD scope in #158.
