export const WASM_CANARY_CONTRACT = Object.freeze({
  canary: 'unzen-cloudflare-wasm-feasibility',
  contractVersion: '1.0.0',
  moduleType: 'WebAssembly.Module',
  wasmBytes: 109,
  wasmSha256: '6f311dd115e63448a0e0bf11b12fa29cc1c851112f38732b58ceebc09ba548aa',
  result: 0,
});

export function validateWasmCanaryPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid', reason: 'payload-not-object' };
  }

  for (const [key, expected] of Object.entries(WASM_CANARY_CONTRACT)) {
    if (value[key] !== expected) {
      return {
        status: 'invalid',
        reason: `contract-mismatch:${key}`,
        expected,
        actual: value[key],
      };
    }
  }

  if (value.status !== 'pass') {
    return {
      status: 'invalid',
      reason: 'contract-mismatch:status',
      expected: 'pass',
      actual: value.status,
    };
  }

  return { status: 'valid' };
}
