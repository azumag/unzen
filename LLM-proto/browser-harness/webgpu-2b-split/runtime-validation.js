const TENSOR_TYPE_BYTES = Object.freeze({
  float64: 8,
  float32: 4,
  float16: 2,
  int64: 8,
  int32: 4,
  int16: 2,
  int8: 1,
  uint64: 8,
  uint32: 4,
  uint16: 2,
  uint8: 1,
  bool: 1,
});
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const WORKER_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_CHECKPOINT_ID_LENGTH = 128;
const MAX_SAFE_TOKEN_ID_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function decodedBase64ByteLength(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return undefined;
  if (!CANONICAL_BASE64.test(value)) return undefined;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function validateCheckpointImmutableMetadata(checkpoint) {
  if (typeof checkpoint?.checkpointId !== 'string'
    || checkpoint.checkpointId.length === 0
    || checkpoint.checkpointId.length > MAX_CHECKPOINT_ID_LENGTH) {
    throw new Error('Coordinator checkpoint contains an invalid checkpoint ID');
  }
  if (typeof checkpoint.checkpointDigest !== 'string' || !SHA256_HEX.test(checkpoint.checkpointDigest)) {
    throw new Error('Coordinator checkpoint contains an invalid checkpoint digest');
  }
  if (typeof checkpoint.sourceWorkerId !== 'string' || !WORKER_ID.test(checkpoint.sourceWorkerId)) {
    throw new Error('Coordinator checkpoint contains an invalid source worker ID');
  }
  const sourceWorkerIdentity = checkpoint.sourceWorkerIdentity;
  if (!sourceWorkerIdentity || typeof sourceWorkerIdentity !== 'object' || Array.isArray(sourceWorkerIdentity)) {
    throw new Error('Coordinator checkpoint contains an invalid source worker identity');
  }
  if (sourceWorkerIdentity.workerId !== checkpoint.sourceWorkerId) {
    throw new Error('Coordinator checkpoint source worker identity does not match source worker ID');
  }
  if (!Number.isSafeInteger(sourceWorkerIdentity.generation) || sourceWorkerIdentity.generation <= 0) {
    throw new Error('Coordinator checkpoint contains an invalid source worker generation');
  }
  if (typeof checkpoint.segmentExecutionMs !== 'number'
    || !Number.isFinite(checkpoint.segmentExecutionMs)
    || checkpoint.segmentExecutionMs < 0) {
    throw new Error('Coordinator checkpoint contains invalid segment execution timing');
  }
}

function validateBoundaryTensorWire(tensor, index, expectedType) {
  if (!tensor || typeof tensor !== 'object' || Array.isArray(tensor)) {
    throw new Error(`Coordinator checkpoint boundary tensor ${index} must be an object`);
  }
  const elementBytes = TENSOR_TYPE_BYTES[tensor.type];
  if (!elementBytes) {
    throw new Error(`Coordinator checkpoint boundary tensor ${index} has unsupported type: ${String(tensor.type)}`);
  }
  if (tensor.type !== expectedType) {
    throw new Error(
      `Coordinator checkpoint boundary tensor ${index} type does not match manifest: expected=${expectedType}, actual=${String(tensor.type)}`,
    );
  }
  if (!Array.isArray(tensor.dims) || tensor.dims.length === 0 || tensor.dims.length > 8) {
    throw new Error(`Coordinator checkpoint boundary tensor ${index} has invalid dims`);
  }
  let elementCount = 1;
  for (const dimension of tensor.dims) {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      throw new Error(`Coordinator checkpoint boundary tensor ${index} has invalid dimension`);
    }
    elementCount *= dimension;
    if (!Number.isSafeInteger(elementCount)) {
      throw new Error(`Coordinator checkpoint boundary tensor ${index} size overflows safe integer range`);
    }
  }
  const expectedBytes = elementCount * elementBytes;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new Error(`Coordinator checkpoint boundary tensor ${index} size overflows safe integer range`);
  }
  if (!Number.isSafeInteger(tensor.bytes) || tensor.bytes !== expectedBytes) {
    throw new Error(
      `Coordinator checkpoint boundary tensor ${index} declared byte length mismatch: declared=${String(tensor.bytes)}, expected=${expectedBytes}`,
    );
  }
  const decodedBytes = decodedBase64ByteLength(tensor.base64);
  if (decodedBytes === undefined) {
    throw new Error(`Coordinator checkpoint boundary tensor ${index} has invalid base64`);
  }
  if (decodedBytes !== expectedBytes) {
    throw new Error(
      `Coordinator checkpoint boundary tensor ${index} encoded byte length mismatch: decoded=${decodedBytes}, expected=${expectedBytes}`,
    );
  }
}

function validateCheckpointInputTokenIds(checkpoint) {
  const tokenIds = checkpoint?.inputTokenIds;
  if (!Array.isArray(tokenIds) || tokenIds.length === 0
    || !tokenIds.every((tokenId) => Number.isSafeInteger(tokenId) && tokenId >= 0)) {
    throw new Error('Coordinator checkpoint contains invalid input token IDs');
  }
}

export function normalizeTokenizerTokenIds(encoded) {
  let values = encoded?.input_ids;
  if (values && typeof values.tolist === 'function') values = values.tolist();
  if (Array.isArray(values) && Array.isArray(values[0])) {
    if (values.length !== 1) {
      throw new Error('tokenizer input_ids must contain exactly one batch');
    }
    [values] = values;
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('tokenizer did not return a non-empty input_ids array');
  }
  return values.map((value, index) => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
    if (typeof value === 'bigint' && value >= 0n && value <= MAX_SAFE_TOKEN_ID_BIGINT) {
      return Number(value);
    }
    throw new Error(`tokenizer returned invalid input token ID at index ${index}`);
  });
}

export function validateCheckpointBoundaryNames(checkpoint, manifest) {
  validateCheckpointImmutableMetadata(checkpoint);
  if (!Array.isArray(checkpoint?.tensors) || checkpoint.tensors.length !== 2) {
    throw new Error('Coordinator checkpoint must contain exactly two boundary tensors');
  }
  validateCheckpointInputTokenIds(checkpoint);
  const expectedNames = manifest?.boundary?.tensors?.map((entry) => entry.name);
  if (!Array.isArray(expectedNames) || expectedNames.length !== 2) {
    throw new Error('manifest must declare exactly two boundary tensor names');
  }
  const expectedType = manifest?.boundary?.dtype;
  if (typeof expectedType !== 'string' || !TENSOR_TYPE_BYTES[expectedType]) {
    throw new Error('manifest must declare a supported boundary dtype');
  }
  const actualNames = checkpoint.tensors.map((wire) => wire?.name);
  if (actualNames.some((name) => typeof name !== 'string' || name.length === 0 || name.length > 1024)) {
    throw new Error('Coordinator checkpoint contains an invalid boundary tensor name');
  }
  if (new Set(actualNames).size !== actualNames.length) {
    throw new Error('Coordinator checkpoint contains duplicate boundary tensor names');
  }
  const expected = new Set(expectedNames);
  if (actualNames.some((name) => !expected.has(name)) || expectedNames.some((name) => !actualNames.includes(name))) {
    throw new Error(`Coordinator checkpoint boundary names do not match manifest: expected=${expectedNames.join(',')}, actual=${actualNames.join(',')}`);
  }
  checkpoint.tensors.forEach((tensor, index) => validateBoundaryTensorWire(tensor, index, expectedType));
}

export function argmaxLastLogits(tensor) {
  if (!tensor || !Array.isArray(tensor.dims) || !tensor.data) {
    throw new Error('missing logits tensor output');
  }
  if (tensor.type !== 'float32' && tensor.type !== 'float64') {
    throw new Error(`unsupported logits tensor type: ${tensor.type}`);
  }
  const dims = tensor.dims;
  if (dims.length !== 3 || dims[0] !== 1
    || !dims.every((dimension) => typeof dimension === 'number' && Number.isSafeInteger(dimension) && dimension > 0)) {
    throw new Error(`unexpected logits shape: ${dims}`);
  }
  const [batch, sequenceLength, vocab] = dims;
  const elementCount = batch * sequenceLength * vocab;
  if (!Number.isSafeInteger(elementCount) || tensor.data.length !== elementCount) {
    throw new Error(`logits data length mismatch: shape=${dims}, data=${tensor.data.length}`);
  }
  const start = (sequenceLength - 1) * vocab;
  let bestIndex = 0;
  let bestValue;
  for (let index = 0; index < tensor.data.length; index++) {
    const value = tensor.data[index];
    if (typeof value !== 'number') {
      throw new Error(`non-numeric logit at index ${index}`);
    }
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite logit at index ${index}`);
    }
    if (index >= start && (index === start || value > bestValue)) {
      bestValue = value;
      bestIndex = index - start;
    }
  }
  return { tokenId: bestIndex, logit: bestValue, elementCount };
}
