import { readCoordinatorJsonResponse } from './coordinator-json-response.js';

// The Coordinator receipt contains only checkpoint binding metadata. Keep the
// browser-side success response small enough that an unexpected response cannot
// force an unbounded allocation before binding validation runs.
export const MAX_CHECKPOINT_RELAY_RECEIPT_BYTES = 16 * 1024;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_CHECKPOINT_ID_LENGTH = 128;

function validateCheckpointRelayReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('checkpoint relay receipt must be an object');
  }
  if (receipt.ok !== true || typeof receipt.idempotent !== 'boolean') {
    throw new Error('checkpoint relay receipt does not confirm a successful Coordinator write');
  }
  if (receipt.relayOwner !== 'coordinator') {
    throw new Error('checkpoint relay receipt is not Coordinator-owned');
  }
  if (typeof receipt.runId !== 'string' || !SAFE_RUN_ID.test(receipt.runId)) {
    throw new Error('checkpoint relay receipt contains an invalid run ID');
  }
  if (typeof receipt.manifestDigest !== 'string' || !SHA256_HEX.test(receipt.manifestDigest)) {
    throw new Error('checkpoint relay receipt contains an invalid manifest digest');
  }
  if (typeof receipt.checkpointId !== 'string'
    || receipt.checkpointId.length === 0
    || receipt.checkpointId.length > MAX_CHECKPOINT_ID_LENGTH) {
    throw new Error('checkpoint relay receipt contains an invalid checkpoint ID');
  }
  if (typeof receipt.checkpointDigest !== 'string' || !SHA256_HEX.test(receipt.checkpointDigest)) {
    throw new Error('checkpoint relay receipt contains an invalid checkpoint digest');
  }
  if (!Number.isSafeInteger(receipt.sourceWorkerGeneration) || receipt.sourceWorkerGeneration <= 0) {
    throw new Error('checkpoint relay receipt contains an invalid source worker generation');
  }
  if (receipt.profileProbeConfirmed !== true) {
    throw new Error('checkpoint relay receipt does not confirm profile isolation');
  }
  if (!Number.isSafeInteger(receipt.tensorBytes) || receipt.tensorBytes <= 0) {
    throw new Error('checkpoint relay receipt contains an invalid tensor byte count');
  }
  return receipt;
}

export async function readCheckpointRelayReceipt(response, { signal } = {}) {
  const receipt = await readCoordinatorJsonResponse(response, {
    maxBytes: MAX_CHECKPOINT_RELAY_RECEIPT_BYTES,
    label: 'checkpoint relay receipt',
    signal,
  });
  return validateCheckpointRelayReceipt(receipt);
}
