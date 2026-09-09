import geometryModule from './wasm-fixtures/segment-geometry.wasm';

if (!(geometryModule instanceof WebAssembly.Module)) {
  throw new TypeError('wasm-lifecycle-module: imported .wasm is not a WebAssembly.Module');
}

let instantiationCount = 0;
let requestCount = 0;
const instance = await WebAssembly.instantiate(geometryModule);
instantiationCount += 1;
const check = instance.exports.check;

if (typeof check !== 'function') {
  throw new TypeError('wasm-lifecycle-module: expected exported check function');
}

export default {
  async fetch() {
    requestCount += 1;
    const result = check(0, 0, 0, 0, 3, 4, 1);
    return Response.json({
      scope: 'module',
      result,
      requestCount,
      instantiationCount,
      moduleType: 'WebAssembly.Module',
    });
  },
};
