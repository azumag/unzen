// The local Coordinator accepts at most 16 MiB for any JSON request body.
// A stored checkpoint is the accepted request body plus Coordinator-owned
// binding metadata (run/worker identities, checkpoint ids/digests, relay flags,
// tensor byte total and timestamp). The browser reserves 4 KiB for that
// generated envelope when bounding a successful checkpoint response. If the
// Coordinator metadata grows beyond this budget, the browser fails closed and
// this transport contract must be changed explicitly rather than silently
// allowing an unbounded allocation.
export const COORDINATOR_JSON_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
export const COORDINATOR_CHECKPOINT_ENVELOPE_MAX_BYTES = 4 * 1024;
export const COORDINATOR_CHECKPOINT_RESPONSE_MAX_BYTES =
  COORDINATOR_JSON_REQUEST_MAX_BYTES + COORDINATOR_CHECKPOINT_ENVELOPE_MAX_BYTES;
