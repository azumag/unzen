import addModule from './wasm-fixtures/add-i32.wasm';

if (!(addModule instanceof WebAssembly.Module)) {
  throw new TypeError('wasm-esm-compat: imported .wasm is not a WebAssembly.Module');
}

const instance = await WebAssembly.instantiate(addModule);
const add = instance.exports.add;

if (typeof add !== 'function') {
  throw new TypeError('wasm-esm-compat: expected exported add function');
}

export default {
  async fetch() {
    const result = add(20, 22);
    if (result !== 42) {
      return Response.json({
        status: 'fail',
        moduleType: 'WebAssembly.Module',
        result,
      }, { status: 500 });
    }

    return Response.json({
      status: 'pass',
      moduleType: 'WebAssembly.Module',
      result,
    });
  },
};
