# Checkpoint request identity contract

`CheckpointStore` separates resume state by `InferenceRequestId`. The branded TypeScript type prevents accidental mixing in typed code, but it does not validate values that arrive through assertions, decoded messages, or other runtime boundaries.

Every public checkpoint-store operation therefore requires the request identity to be a string containing at least one non-whitespace character before any state read or write:

- `save()` validates the checkpoint request identity before creating or updating a request bucket;
- `get()` and `latest()` validate before looking up checkpoint state;
- `deleteAll()` validates before deleting request state.

The store does **not** trim or normalize valid identifiers. For example, `" request "` and `"request"` remain distinct identities, matching the existing branded identifier constructor contract. This avoids silently merging namespaces while still rejecting empty and whitespace-only request identifiers.

This check complements the existing checkpoint validation for segment indexes, hidden-state payloads, tensor metadata, and snapshot ownership isolation. It is not a substitute for authenticated request ownership at higher protocol layers.
