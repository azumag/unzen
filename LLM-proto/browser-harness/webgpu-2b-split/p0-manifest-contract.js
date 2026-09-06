export const SMOLLM2_P0_CONTRACT = Object.freeze({
  schemaVersion: '1.0.0',
  manifestKind: 'unzen-real-two-segment-onnx',
  artifactLayout: 'per-segment-external-data',
  modelId: 'onnx-community/SmolLM2-135M-ONNX',
  modelRevision: '0d747f789bcf79b9b57a4be7f3277b64c185f8ef',
  sourceGraphSha256: 'da1d291b342acafd806b284052053902af82c52121c400789bdf8ab1effdb4c8',
  sourceExternalDataLocation: 'model_q4.onnx_data',
  sourceExternalDataBytes: 181839104,
  sourceExternalDataSha256: '89625d22026f0ccba8ba6007b18818647a28c4fc39c392101f0408f089e63c21',
  modelClass: 'SmolLM2-135M',
  quantization: 'q4',
  totalLayers: 30,
  splitLayer: 15,
  hiddenSize: 576,
  kvHeads: 3,
  headSize: 64,
  boundaryTensorCount: 2,
  boundaryBytesPerToken: 2 * 576 * 4,
  targetBytes: 200 * 1024 * 1024,
  preferredMaxBytes: 256 * 1024 * 1024,
  normalMaxBytes: 512 * 1024 * 1024,
  absoluteMaxBytes: 1024 * 1024 * 1024,
  requiredTier: 'preferred',
});

function objectField(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`P0 manifest ${field} must be an object`);
  }
  return value;
}

function exact(value, expected, field) {
  if (value !== expected) {
    throw new Error(`P0 manifest ${field} mismatch: expected ${String(expected)}, got ${String(value)}`);
  }
}

function positiveSafeInteger(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`P0 manifest ${field} must be a positive safe integer`);
  }
  return value;
}

function canonicalSha256(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`P0 manifest ${field} must be a canonical lowercase SHA-256 digest`);
  }
  return value;
}

export function validateSmolLm2P0Manifest(manifest) {
  const contract = SMOLLM2_P0_CONTRACT;
  const root = objectField(manifest, 'root');
  exact(root.schemaVersion, contract.schemaVersion, 'schemaVersion');
  exact(root.kind, contract.manifestKind, 'kind');
  exact(root.artifactLayout, contract.artifactLayout, 'artifactLayout');
  exact(root.splitLayer, contract.splitLayer, 'splitLayer');
  exact(root.hiddenSize, contract.hiddenSize, 'hiddenSize');

  const sourceModel = objectField(root.sourceModel, 'sourceModel');
  exact(
    canonicalSha256(sourceModel.sha256, 'sourceModel.sha256'),
    contract.sourceGraphSha256,
    'sourceModel.sha256',
  );
  if (!Array.isArray(sourceModel.externalData) || sourceModel.externalData.length !== 1) {
    throw new Error('P0 manifest sourceModel.externalData must contain exactly one entry');
  }
  const sourceExternal = objectField(sourceModel.externalData[0], 'sourceModel.externalData[0]');
  exact(sourceExternal.location, contract.sourceExternalDataLocation, 'sourceModel.externalData[0].location');
  exact(
    positiveSafeInteger(sourceExternal.bytes, 'sourceModel.externalData[0].bytes'),
    contract.sourceExternalDataBytes,
    'sourceModel.externalData[0].bytes',
  );
  exact(
    canonicalSha256(sourceExternal.sha256, 'sourceModel.externalData[0].sha256'),
    contract.sourceExternalDataSha256,
    'sourceModel.externalData[0].sha256',
  );

  const profile = objectField(root.modelProfile, 'modelProfile');
  exact(profile.modelId, contract.modelId, 'modelProfile.modelId');
  exact(profile.revision, contract.modelRevision, 'modelProfile.revision');
  exact(profile.modelClass, contract.modelClass, 'modelProfile.modelClass');
  exact(profile.quantization, contract.quantization, 'modelProfile.quantization');
  exact(profile.totalLayers, contract.totalLayers, 'modelProfile.totalLayers');
  exact(profile.splitLayer, contract.splitLayer, 'modelProfile.splitLayer');
  const hints = objectField(profile.runtimeHints, 'modelProfile.runtimeHints');
  exact(hints.hiddenSize, contract.hiddenSize, 'modelProfile.runtimeHints.hiddenSize');
  exact(hints.kvHeads, contract.kvHeads, 'modelProfile.runtimeHints.kvHeads');
  exact(hints.headSize, contract.headSize, 'modelProfile.runtimeHints.headSize');

  const boundary = objectField(root.boundary, 'boundary');
  exact(boundary.dtype, 'float32', 'boundary.dtype');
  exact(boundary.tensorCount, contract.boundaryTensorCount, 'boundary.tensorCount');
  exact(boundary.bytesPerToken, contract.boundaryBytesPerToken, 'boundary.bytesPerToken');
  if (!Array.isArray(boundary.tensors) || boundary.tensors.length !== contract.boundaryTensorCount) {
    throw new Error(`P0 manifest boundary.tensors must contain exactly ${contract.boundaryTensorCount} entries`);
  }
  for (const [index, tensor] of boundary.tensors.entries()) {
    if (!tensor || typeof tensor !== 'object' || Array.isArray(tensor)
      || typeof tensor.name !== 'string' || tensor.name.length === 0) {
      throw new Error(`P0 manifest boundary.tensors[${index}] must declare a non-empty name`);
    }
  }

  if (!Array.isArray(root.segments) || root.segments.length !== 2) {
    throw new Error('P0 manifest must contain exactly two segments');
  }
  const segmentsByIndex = new Map();
  for (const segment of root.segments) {
    const entry = objectField(segment, 'segments[]');
    if (!Number.isSafeInteger(entry.index) || ![0, 1].includes(entry.index) || segmentsByIndex.has(entry.index)) {
      throw new Error(`P0 manifest has invalid or duplicate segment index: ${String(entry.index)}`);
    }
    const bytes = positiveSafeInteger(entry.browserArtifactBytes, `segments[${entry.index}].browserArtifactBytes`);
    if (bytes > contract.preferredMaxBytes) {
      throw new Error(`P0 manifest segment ${entry.index} exceeds preferred browser budget: ${bytes}`);
    }
    exact(entry.browserArtifactTier, contract.requiredTier, `segments[${entry.index}].browserArtifactTier`);
    segmentsByIndex.set(entry.index, entry);
  }
  if (!segmentsByIndex.has(0) || !segmentsByIndex.has(1)) {
    throw new Error('P0 manifest must contain segment indexes 0 and 1');
  }

  const budget = objectField(root.browserArtifactBudget, 'browserArtifactBudget');
  exact(budget.targetBytes, contract.targetBytes, 'browserArtifactBudget.targetBytes');
  exact(budget.preferredMaxBytes, contract.preferredMaxBytes, 'browserArtifactBudget.preferredMaxBytes');
  exact(budget.normalMaxBytes, contract.normalMaxBytes, 'browserArtifactBudget.normalMaxBytes');
  exact(budget.absoluteMaxBytes, contract.absoluteMaxBytes, 'browserArtifactBudget.absoluteMaxBytes');
  exact(budget.requiredTier, contract.requiredTier, 'browserArtifactBudget.requiredTier');
  exact(budget.requiredMaxBytes, contract.preferredMaxBytes, 'browserArtifactBudget.requiredMaxBytes');
  const maximum = positiveSafeInteger(
    budget.maximumSegmentArtifactBytes,
    'browserArtifactBudget.maximumSegmentArtifactBytes',
  );
  if (maximum > contract.preferredMaxBytes) {
    throw new Error(`P0 manifest maximum segment artifact exceeds preferred budget: ${maximum}`);
  }
  if (!Array.isArray(budget.segments) || budget.segments.length !== 2) {
    throw new Error('P0 manifest browserArtifactBudget.segments must contain exactly two entries');
  }
  let measuredMaximum = 0;
  const budgetIndexes = new Set();
  for (const report of budget.segments) {
    const entry = objectField(report, 'browserArtifactBudget.segments[]');
    if (!Number.isSafeInteger(entry.index) || !segmentsByIndex.has(entry.index) || budgetIndexes.has(entry.index)) {
      throw new Error(`P0 manifest has invalid or duplicate budget segment index: ${String(entry.index)}`);
    }
    budgetIndexes.add(entry.index);
    const bytes = positiveSafeInteger(
      entry.artifactBytes,
      `browserArtifactBudget.segments[${entry.index}].artifactBytes`,
    );
    const segment = segmentsByIndex.get(entry.index);
    exact(bytes, segment.browserArtifactBytes, `browserArtifactBudget.segments[${entry.index}].artifactBytes`);
    exact(entry.tier, contract.requiredTier, `browserArtifactBudget.segments[${entry.index}].tier`);
    measuredMaximum = Math.max(measuredMaximum, bytes);
  }
  exact(maximum, measuredMaximum, 'browserArtifactBudget.maximumSegmentArtifactBytes');

  return {
    status: 'pass',
    modelId: contract.modelId,
    modelRevision: contract.modelRevision,
    sourceGraphSha256: contract.sourceGraphSha256,
    requiredTier: contract.requiredTier,
    requiredMaxBytes: contract.preferredMaxBytes,
    segmentCount: 2,
  };
}
