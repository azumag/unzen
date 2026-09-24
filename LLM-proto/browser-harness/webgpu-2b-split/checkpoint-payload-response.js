import { readCoordinatorJsonResponse } from './coordinator-json-response.js';
import { COORDINATOR_CHECKPOINT_RESPONSE_MAX_BYTES } from './checkpoint-transport-contract.js';
import {
  assertCoordinatorReceiptRunId,
  resolveCoordinatorReceiptExpectedRunId,
} from './coordinator-receipt-run-binding.js';

export async function readCheckpointPayloadResponse(response, { signal, expectedRunId } = {}) {
  const expected = resolveCoordinatorReceiptExpectedRunId(expectedRunId);
  const checkpoint = await readCoordinatorJsonResponse(response, {
    maxBytes: COORDINATOR_CHECKPOINT_RESPONSE_MAX_BYTES,
    label: 'checkpoint payload response',
    signal,
  });
  return assertCoordinatorReceiptRunId(checkpoint, expected, 'checkpoint payload response');
}
