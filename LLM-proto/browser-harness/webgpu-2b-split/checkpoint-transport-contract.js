// The local Coordinator accepts at most 16 MiB for any JSON request body.
// A stored checkpoint is the accepted request body plus Coordinator-owned
// binding metadata (run/worker identities, checkpoint ids/digests, relay flags,
// tensor byte total and timestamp). Reserve 4 KiB for that generated envelope
// and enforce the resulting response ceiling on both the Coordinator GET path
// and the browser reader. If the Coordinator metadata grows beyond this budget,
// the transport contract must be changed explicitly rather than silently
// allowing an unbounded browser allocation.
export const COORDINATOR_JSON_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
export const COORDINATOR_CHECKPOINT_ENVELOPE_MAX_BYTES = 4 * 1024;
export const COORDINATOR_CHECKPOINT_RESPONSE_MAX_BYTES =
  COORDINATOR_JSON_REQUEST_MAX_BYTES + COORDINATOR_CHECKPOINT_ENVELOPE_MAX_BYTES;
