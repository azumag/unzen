const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function resolveCoordinatorReceiptExpectedRunId(
  expectedRunId,
  search = globalThis.location?.search,
) {
  let resolved = expectedRunId;
  if (resolved === undefined) {
    const params = new URLSearchParams(typeof search === 'string' ? search : '');
    resolved = params.get('run') ?? 'demo';
  }
  if (typeof resolved !== 'string' || !SAFE_RUN_ID.test(resolved)) {
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
