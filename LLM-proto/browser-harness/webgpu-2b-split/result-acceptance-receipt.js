import { readCoordinatorJsonResponse } from './coordinator-json-response.js';

// The result acceptance response is metadata-only. Keep this transport boundary
// small before profile-isolation and checkpoint binding validation runs.
export const MAX_RESULT_ACCEPTANCE_RECEIPT_BYTES = 16 * 1024;

export async function readResultAcceptanceReceipt(response, { signal } = {}) {
  return readCoordinatorJsonResponse(response, {
    maxBytes: MAX_RESULT_ACCEPTANCE_RECEIPT_BYTES,
    label: 'result acceptance receipt',
    signal,
  });
}
