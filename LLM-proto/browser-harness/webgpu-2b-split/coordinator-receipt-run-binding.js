import { BROWSER_RUN_ID_PATTERN, DEFAULT_BROWSER_RUN_ID } from './run-id.js';

export function resolveCoordinatorReceiptExpectedRunId(
  expectedRunId,
  search = globalThis.location?.search,
) {
  let resolved = expectedRunId;
  if (resolved === undefined) {
    const params = new URLSearchParams(typeof search === 'string' ? search : '');
    resolved = params.get('run') ?? DEFAULT_BROWSER_RUN_ID;
  }
  if (typeof resolved !== 'string' || !BROWSER_RUN_ID_PATTERN.test(resolved)) {
    throw new Error('Coordinator receipt expected run ID is invalid');
  }
  return resolved;
}

export function assertCoordinatorReceiptRunId(receipt, expectedRunId, label) {
  if (receipt.runId !== expectedRunId) {
    throw new Error(`${label} is bound to a different run ID`);
  }
  return receipt;
}
