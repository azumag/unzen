import { readCoordinatorJsonResponse } from './coordinator-json-response.js';
import {
  assertCoordinatorReceiptRunId,
  resolveCoordinatorReceiptExpectedRunId,
} from './coordinator-receipt-run-binding.js';

// The result acceptance response is metadata-only. Keep this transport boundary
// small before profile-isolation and checkpoint binding validation runs.
export const MAX_RESULT_ACCEPTANCE_RECEIPT_BYTES = 16 * 1024;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_CHECKPOINT_ID_LENGTH = 128;

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateProfileIsolationEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('result acceptance receipt contains invalid profile isolation evidence');
  }
  if (evidence.method !== 'coordinator-issued-http-only-cookie' || evidence.confirmed !== true) {
    throw new Error('result acceptance receipt contains invalid profile isolation evidence');
  }
  if (typeof evidence.sourceWorkerId !== 'string' || !SAFE_ID.test(evidence.sourceWorkerId)
    || typeof evidence.segment1WorkerId !== 'string' || !SAFE_ID.test(evidence.segment1WorkerId)) {
    throw new Error('result acceptance receipt contains invalid profile isolation worker identity');
  }
  if (!isPositiveSafeInteger(evidence.sourceWorkerGeneration)
    || !isPositiveSafeInteger(evidence.segment1WorkerGeneration)) {
    throw new Error('result acceptance receipt contains invalid profile isolation worker generation');
  }
  if (typeof evidence.sourceProfileProbeHash !== 'string' || !SHA256_HEX.test(evidence.sourceProfileProbeHash)
    || typeof evidence.segment1ProfileProbeHash !== 'string' || !SHA256_HEX.test(evidence.segment1ProfileProbeHash)
    || evidence.sourceProfileProbeHash === evidence.segment1ProfileProbeHash) {
    throw new Error('result acceptance receipt contains invalid profile isolation probe hashes');
  }
}

function validateResultAcceptanceReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('result acceptance receipt must be an object');
  }
  if (receipt.ok !== true || typeof receipt.idempotent !== 'boolean') {
    throw new Error('result acceptance receipt does not confirm a successful Coordinator write');
  }
  if (typeof receipt.runId !== 'string' || !SAFE_ID.test(receipt.runId)) {
    throw new Error('result acceptance receipt contains an invalid run ID');
  }
  if (typeof receipt.resultDigest !== 'string' || !SHA256_HEX.test(receipt.resultDigest)) {
    throw new Error('result acceptance receipt contains an invalid result digest');
  }
  if (typeof receipt.checkpointId !== 'string'
    || receipt.checkpointId.length === 0
    || receipt.checkpointId.length > MAX_CHECKPOINT_ID_LENGTH) {
    throw new Error('result acceptance receipt contains an invalid checkpoint ID');
  }
  if (typeof receipt.checkpointDigest !== 'string' || !SHA256_HEX.test(receipt.checkpointDigest)) {
    throw new Error('result acceptance receipt contains an invalid checkpoint digest');
  }
  if (receipt.profileIsolationConfirmed !== true) {
    throw new Error('result acceptance receipt does not confirm browser profile isolation');
  }
  validateProfileIsolationEvidence(receipt.profileIsolationEvidence);
  return receipt;
}

export async function readResultAcceptanceReceipt(response, { signal, expectedRunId } = {}) {
  const expected = resolveCoordinatorReceiptExpectedRunId(expectedRunId);
  const receipt = await readCoordinatorJsonResponse(response, {
    maxBytes: MAX_RESULT_ACCEPTANCE_RECEIPT_BYTES,
    label: 'result acceptance receipt',
    signal,
  });
  return assertCoordinatorReceiptRunId(
    validateResultAcceptanceReceipt(receipt),
    expected,
    'result acceptance receipt',
  );
}
