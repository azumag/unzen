export function validateCheckpointBoundaryNames(checkpoint, manifest) {
  if (!Array.isArray(checkpoint?.tensors) || checkpoint.tensors.length !== 2) {
    throw new Error('Coordinator checkpoint must contain exactly two boundary tensors');
  }
  const expectedNames = manifest?.boundary?.tensors?.map((entry) => entry.name);
  if (!Array.isArray(expectedNames) || expectedNames.length !== 2) {
    throw new Error('manifest must declare exactly two boundary tensor names');
  }
  const actualNames = checkpoint.tensors.map((wire) => wire?.name);
  if (actualNames.some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new Error('Coordinator checkpoint contains an invalid boundary tensor name');
  }
  if (new Set(actualNames).size !== actualNames.length) {
    throw new Error('Coordinator checkpoint contains duplicate boundary tensor names');
  }
  const expected = new Set(expectedNames);
  if (actualNames.some((name) => !expected.has(name)) || expectedNames.some((name) => !actualNames.includes(name))) {
    throw new Error(`Coordinator checkpoint boundary names do not match manifest: expected=${expectedNames.join(',')}, actual=${actualNames.join(',')}`);
  }
}

export function argmaxLastLogits(tensor) {
  if (!tensor || !Array.isArray(tensor.dims) || !tensor.data) {
    throw new Error('missing logits tensor output');
  }
  if (tensor.type !== 'float32' && tensor.type !== 'float64') {
    throw new Error(`unsupported logits tensor type: ${tensor.type}`);
  }
  const dims = tensor.dims.map(Number);
  if (dims.length !== 3 || dims[0] !== 1
    || !dims.every((dimension) => Number.isSafeInteger(dimension) && dimension > 0)) {
    throw new Error(`unexpected logits shape: ${dims}`);
  }
  const [batch, sequenceLength, vocab] = dims;
  const elementCount = batch * sequenceLength * vocab;
  if (!Number.isSafeInteger(elementCount) || tensor.data.length !== elementCount) {
    throw new Error(`logits data length mismatch: shape=${dims}, data=${tensor.data.length}`);
  }
  for (let index = 0; index < tensor.data.length; index++) {
    const value = Number(tensor.data[index]);
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite logit at index ${index}`);
    }
  }
  const start = (sequenceLength - 1) * vocab;
  let bestIndex = 0;
  let bestValue = Number(tensor.data[start]);
  for (let index = 1; index < vocab; index++) {
    const value = Number(tensor.data[start + index]);
    if (value > bestValue) {
      bestValue = value;
      bestIndex = index;
    }
  }
  return { tokenId: bestIndex, logit: bestValue, elementCount };
}
