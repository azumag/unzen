import { readCoordinatorJsonResponse } from './coordinator-json-response.js';
import { COORDINATOR_CHECKPOINT_RESPONSE_MAX_BYTES } from './checkpoint-transport-contract.js';

export async function readCheckpointPayloadResponse(response, { signal } = {}) {
  return readCoordinatorJsonResponse(response, {
    maxBytes: COORDINATOR_CHECKPOINT_RESPONSE_MAX_BYTES,
    label: 'checkpoint payload response',
    signal,
  });
}
