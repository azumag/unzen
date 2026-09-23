import { readCoordinatorJsonResponse } from './coordinator-json-response.js';

// The Coordinator receipt contains only checkpoint binding metadata. Keep the
// browser-side success response small enough that an unexpected response cannot
// force an unbounded allocation before binding validation runs.
export const MAX_CHECKPOINT_RELAY_RECEIPT_BYTES = 16 * 1024;

export async function readCheckpointRelayReceipt(response, { signal } = {}) {
  return readCoordinatorJsonResponse(response, {
    maxBytes: MAX_CHECKPOINT_RELAY_RECEIPT_BYTES,
    label: 'checkpoint relay receipt',
    signal,
  });
}
