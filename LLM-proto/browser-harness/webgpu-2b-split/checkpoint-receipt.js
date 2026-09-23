import { readResponseBytesBounded } from './artifact-cache.js';

// The Coordinator receipt contains only checkpoint binding metadata. Keep the
// browser-side success response small enough that an unexpected response cannot
// force an unbounded allocation before binding validation runs.
export const MAX_CHECKPOINT_RELAY_RECEIPT_BYTES = 16 * 1024;

export async function readCheckpointRelayReceipt(response, { signal } = {}) {
  const bytes = await readResponseBytesBounded(response, {
    maxBytes: MAX_CHECKPOINT_RELAY_RECEIPT_BYTES,
    url: 'checkpoint relay receipt',
    signal,
  });
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text);
}
