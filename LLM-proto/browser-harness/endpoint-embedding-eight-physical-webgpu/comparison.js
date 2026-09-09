export function compareFloat32Bytes(actual, expected) {
  if (!(actual instanceof Float32Array) || !(expected instanceof Float32Array)) {
    throw new Error('byte comparison requires Float32Array inputs');
  }
  if (actual.length !== expected.length) throw new Error('comparison length mismatch');

  const actualBytes = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
  const expectedBytes = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
  let firstByteMismatch = -1;
  for (let index = 0; index < actualBytes.length; index += 1) {
    if (actualBytes[index] !== expectedBytes[index]) {
      firstByteMismatch = index;
      break;
    }
  }

  let maxAbsDiff = 0;
  let worstIndex = -1;
  for (let index = 0; index < actual.length; index += 1) {
    const diff = Math.abs(actual[index] - expected[index]);
    if (Number.isNaN(diff)) {
      if (firstByteMismatch !== -1 && worstIndex === -1) worstIndex = index;
      continue;
    }
    if (diff > maxAbsDiff) {
      maxAbsDiff = diff;
      worstIndex = index;
    }
  }

  return Object.freeze({
    exactEqual: firstByteMismatch === -1,
    firstByteMismatch,
    maxAbsDiff,
    worstIndex,
  });
}
