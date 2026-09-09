import geometryModule from './wasm-fixtures/segment-geometry.wasm';

const CONTRACT_VERSION = '1.0.0';
const WASM_BYTES = 109;
const WASM_SHA256 = '6f311dd115e63448a0e0bf11b12fa29cc1c851112f38732b58ceebc09ba548aa';

if (!(geometryModule instanceof WebAssembly.Module)) {
  throw new TypeError('wasm-canary: imported .wasm is not a WebAssembly.Module');
}

const instance = await WebAssembly.instantiate(geometryModule);
const check = instance.exports.check;

if (typeof check !== 'function') {
  throw new TypeError('wasm-canary: expected exported check function');
}

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return new Response('GET required', { status: 405, headers: { allow: 'GET' } });
    }

    const result = check(0, 0, 0, 0, 3, 4, 1);
    if (result !== 0) {
      return Response.json(
        {
          status: 'fail',
          contractVersion: CONTRACT_VERSION,
          result,
        },
        { status: 500 },
      );
    }

    return Response.json({
      status: 'pass',
      canary: 'unzen-cloudflare-wasm-feasibility',
      contractVersion: CONTRACT_VERSION,
      moduleType: 'WebAssembly.Module',
      wasmBytes: WASM_BYTES,
      wasmSha256: WASM_SHA256,
      result,
    });
  },
};
