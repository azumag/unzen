import type { SegmentArtifact, SegmentedModelManifest } from './model-manifest.js';
import { parseQuantizationBits } from './model-manifest.js';
import { createFixtureModelManifest } from './model-manifest-fixtures.js';

export type WebGpuRuntimeName = 'transformers-js-v4' | 'webllm' | 'onnxruntime-web';
export type FeasibilityStatus = 'pass' | 'fail';

export interface WebGpuRuntimeCandidate {
  readonly name: WebGpuRuntimeName;
  readonly supportsWebGPU: boolean;
  readonly supportsLayerBoundary: boolean;
  readonly supportsCheckpointResume: boolean;
  readonly supportedQuantizationBits: readonly number[];
}

export interface DispatcherAssumptions {
  readonly workerVramFreeMB: number;
  readonly gpuBusyRatio: number;
  readonly cpuBusyRatio: number;
  readonly checkpointBytesPerSecond: number;
  readonly loadBudgetRatio: number;
}

/**
 * Feasibility input. The model geometry comes from a `SegmentedModelManifest`
 * (issue #102) instead of synthetic hard-coded values; the 30B / 8-segment
 * values are an EXAMPLE fixture, not measured fact.
 */
export interface WebGpu30BFeasibilityManifest {
  readonly model: SegmentedModelManifest;
  readonly checkpointTensor: {
    readonly batchSize: number;
    readonly sequenceLength: number;
    readonly hiddenSize: number;
    readonly dtype: 'float16' | 'float32';
  };
  readonly workerMemoryBudgetMB: number;
  readonly maxCheckpointTransferMs: number;
  readonly dispatcherAssumptions: DispatcherAssumptions;
  readonly runtimeCandidates: readonly WebGpuRuntimeCandidate[];
}

export interface RuntimeFeasibilityReport {
  readonly name: WebGpuRuntimeName;
  readonly status: FeasibilityStatus;
  readonly failureReasons: readonly string[];
}

export interface SegmentFeasibilityReport {
  readonly index: number;
  readonly layerStart: number;
  readonly layerEnd: number;
  readonly estimatedVramMB: number;
  readonly fitsWorkerMemoryBudget: boolean;
  readonly fitsDispatcherWorkerTelemetry: boolean;
}

export interface WebGpu30BFeasibilityReport {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly manifestDigest: string;
  readonly status: FeasibilityStatus;
  readonly segmentCount: number;
  readonly quantizationBits: number;
  readonly checkpointTensorShape: readonly [number, number, number];
  readonly checkpointBytes: number;
  readonly checkpointTransferMs: number;
  readonly segments: readonly SegmentFeasibilityReport[];
  readonly runtimes: readonly RuntimeFeasibilityReport[];
  readonly scaleUpGates: readonly {
    readonly name: string;
    readonly status: FeasibilityStatus;
    readonly reason: string;
  }[];
  readonly failureReasons: readonly string[];
}

const BYTES_PER_DTYPE = {
  float16: 2,
  float32: 4,
} as const;

const WEBGPU_RUNTIME_NAMES = [
  'transformers-js-v4',
  'webllm',
  'onnxruntime-web',
] as const satisfies readonly WebGpuRuntimeName[];

export function evaluateWebGpu30BFeasibility(
  manifest: WebGpu30BFeasibilityManifest,
): WebGpu30BFeasibilityReport {
  validateFeasibilityManifestRuntimeEnvelope(manifest);

  const model = manifest.model;
  const checkpointTensorShape = [
    manifest.checkpointTensor.batchSize,
    manifest.checkpointTensor.sequenceLength,
    manifest.checkpointTensor.hiddenSize,
  ] as const;
  const checkpointElements = checkedMultiplySafeInteger(
    checkpointTensorShape[0],
    checkpointTensorShape[1],
    'checkpoint tensor element count',
  );
  const checkpointElementCount = checkedMultiplySafeInteger(
    checkpointElements,
    checkpointTensorShape[2],
    'checkpoint tensor element count',
  );
  const checkpointBytes = checkedMultiplySafeInteger(
    checkpointElementCount,
    BYTES_PER_DTYPE[manifest.checkpointTensor.dtype],
    'checkpoint tensor byte length',
  );
  const checkpointTransferMs = checkedCeilDurationMs(
    checkpointBytes,
    manifest.dispatcherAssumptions.checkpointBytesPerSecond,
  );
  const quantizationBits = parseQuantizationBits(model.quantization);
  const segments = model.segments.map((artifact) => ({
    index: artifact.index,
    layerStart: artifact.layerStart,
    layerEnd: artifact.layerEnd,
    estimatedVramMB: artifact.estimatedMemoryMB,
    fitsWorkerMemoryBudget: artifact.estimatedMemoryMB <= manifest.workerMemoryBudgetMB,
    fitsDispatcherWorkerTelemetry: artifact.estimatedMemoryMB <=
      manifest.dispatcherAssumptions.workerVramFreeMB,
  }));
  const runtimes = manifest.runtimeCandidates.map((runtime) => evaluateRuntime(
    runtime,
    quantizationBits,
  ));
  const scaleUpGates = [
    evaluateParameterGate(model.parameterCount / 1e9),
    evaluateSegmentGate(model.segments),
    evaluateQuantizationGate(quantizationBits),
    evaluateMemoryGate(segments),
    evaluateLoadGate(manifest.dispatcherAssumptions),
    evaluateCheckpointGate(checkpointTransferMs, manifest.maxCheckpointTransferMs),
    evaluateRuntimeGate(runtimes),
  ];
  const failureReasons = scaleUpGates
    .filter((gate) => gate.status === 'fail')
    .map((gate) => `${gate.name}: ${gate.reason}`);

  return {
    modelId: model.modelId,
    modelRevision: model.modelRevision,
    manifestDigest: model.manifestDigest,
    status: failureReasons.length === 0 ? 'pass' : 'fail',
    segmentCount: model.segments.length,
    quantizationBits,
    checkpointTensorShape,
    checkpointBytes,
    checkpointTransferMs,
    segments,
    runtimes,
    scaleUpGates,
    failureReasons,
  };
}

export function createDefault30BFeasibilityManifest(): WebGpu30BFeasibilityManifest {
  return {
    model: createFixtureModelManifest(),
    checkpointTensor: {
      batchSize: 1,
      sequenceLength: 512,
      hiddenSize: 6656,
      dtype: 'float16',
    },
    workerMemoryBudgetMB: 4096,
    maxCheckpointTransferMs: 750,
    dispatcherAssumptions: {
      workerVramFreeMB: 8400,
      gpuBusyRatio: 0.02,
      cpuBusyRatio: 0.01,
      checkpointBytesPerSecond: 16 * 1024 * 1024,
      loadBudgetRatio: 0.03,
    },
    runtimeCandidates: [
      {
        name: 'transformers-js-v4',
        supportsWebGPU: true,
        supportsLayerBoundary: false,
        supportsCheckpointResume: false,
        supportedQuantizationBits: [4, 8],
      },
      {
        name: 'webllm',
        supportsWebGPU: true,
        supportsLayerBoundary: true,
        supportsCheckpointResume: true,
        supportedQuantizationBits: [3, 4],
      },
      {
        name: 'onnxruntime-web',
        supportsWebGPU: true,
        supportsLayerBoundary: true,
        supportsCheckpointResume: false,
        supportedQuantizationBits: [4, 8],
      },
    ],
  };
}

function validateFeasibilityManifestRuntimeEnvelope(
  value: unknown,
): asserts value is WebGpu30BFeasibilityManifest {
  if (!isRecord(value)) {
    throw new Error('WebGPU feasibility manifest must be an object');
  }

  const model = value.model;
  if (!isRecord(model)) {
    throw new Error('model must be an object');
  }
  assertNonEmptyString(model.modelId, 'model.modelId');
  assertNonEmptyString(model.modelRevision, 'model.modelRevision');
  assertNonEmptyString(model.manifestDigest, 'model.manifestDigest');
  assertPositiveFiniteNumber(model.parameterCount, 'model.parameterCount');
  assertNonEmptyString(model.quantization, 'model.quantization');
  if (!Array.isArray(model.segments)) {
    throw new Error('model.segments must be an array');
  }
  for (let index = 0; index < model.segments.length; index++) {
    validateFeasibilitySegmentRuntimeEnvelope(model.segments[index], index);
  }

  const checkpointTensor = value.checkpointTensor;
  if (!isRecord(checkpointTensor)) {
    throw new Error('checkpointTensor must be an object');
  }
  assertPositiveSafeInteger(checkpointTensor.batchSize, 'checkpointTensor.batchSize');
  assertPositiveSafeInteger(checkpointTensor.sequenceLength, 'checkpointTensor.sequenceLength');
  assertPositiveSafeInteger(checkpointTensor.hiddenSize, 'checkpointTensor.hiddenSize');
  if (checkpointTensor.dtype !== 'float16' && checkpointTensor.dtype !== 'float32') {
    throw new Error('checkpointTensor.dtype must be one of: float16, float32');
  }

  assertPositiveFiniteNumber(value.workerMemoryBudgetMB, 'workerMemoryBudgetMB');
  assertNonNegativeFiniteNumber(value.maxCheckpointTransferMs, 'maxCheckpointTransferMs');

  const assumptions = value.dispatcherAssumptions;
  if (!isRecord(assumptions)) {
    throw new Error('dispatcherAssumptions must be an object');
  }
  assertNonNegativeFiniteNumber(assumptions.workerVramFreeMB, 'dispatcherAssumptions.workerVramFreeMB');
  assertNonNegativeFiniteNumber(assumptions.gpuBusyRatio, 'dispatcherAssumptions.gpuBusyRatio');
  assertNonNegativeFiniteNumber(assumptions.cpuBusyRatio, 'dispatcherAssumptions.cpuBusyRatio');
  assertPositiveFiniteNumber(
    assumptions.checkpointBytesPerSecond,
    'dispatcherAssumptions.checkpointBytesPerSecond',
  );
  assertNonNegativeFiniteNumber(assumptions.loadBudgetRatio, 'dispatcherAssumptions.loadBudgetRatio');

  if (!Array.isArray(value.runtimeCandidates)) {
    throw new Error('runtimeCandidates must be an array');
  }
  for (let index = 0; index < value.runtimeCandidates.length; index++) {
    validateRuntimeCandidateRuntimeEnvelope(value.runtimeCandidates[index], index);
  }
}

function validateFeasibilitySegmentRuntimeEnvelope(value: unknown, position: number): void {
  if (!isRecord(value)) {
    throw new Error(`model.segments[${position}] must be an object`);
  }
  assertNonNegativeSafeInteger(value.index, `model.segments[${position}].index`);
  assertNonNegativeSafeInteger(value.layerStart, `model.segments[${position}].layerStart`);
  assertNonNegativeSafeInteger(value.layerEnd, `model.segments[${position}].layerEnd`);
  assertPositiveFiniteNumber(
    value.estimatedMemoryMB,
    `model.segments[${position}].estimatedMemoryMB`,
  );
}

function validateRuntimeCandidateRuntimeEnvelope(value: unknown, position: number): void {
  if (!isRecord(value)) {
    throw new Error(`runtimeCandidates[${position}] must be an object`);
  }
  if (!WEBGPU_RUNTIME_NAMES.includes(value.name as WebGpuRuntimeName)) {
    throw new Error(
      `runtimeCandidates[${position}].name must be one of: ${WEBGPU_RUNTIME_NAMES.join(', ')}`,
    );
  }
  assertBoolean(value.supportsWebGPU, `runtimeCandidates[${position}].supportsWebGPU`);
  assertBoolean(value.supportsLayerBoundary, `runtimeCandidates[${position}].supportsLayerBoundary`);
  assertBoolean(value.supportsCheckpointResume, `runtimeCandidates[${position}].supportsCheckpointResume`);
  if (!Array.isArray(value.supportedQuantizationBits)) {
    throw new Error(`runtimeCandidates[${position}].supportedQuantizationBits must be an array`);
  }
  for (let bitIndex = 0; bitIndex < value.supportedQuantizationBits.length; bitIndex++) {
    assertPositiveSafeInteger(
      value.supportedQuantizationBits[bitIndex],
      `runtimeCandidates[${position}].supportedQuantizationBits[${bitIndex}]`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

function assertBoolean(value: unknown, fieldName: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }
}

function assertPositiveSafeInteger(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

function assertPositiveFiniteNumber(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive finite number`);
  }
}

function assertNonNegativeFiniteNumber(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative finite number`);
  }
}

function checkedMultiplySafeInteger(left: number, right: number, fieldName: string): number {
  if (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left)) {
    throw new Error(`${fieldName} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return left * right;
}

function checkedCeilDurationMs(bytes: number, bytesPerSecond: number): number {
  const durationMs = Math.ceil((bytes / bytesPerSecond) * 1000);
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new Error('checkpoint transfer duration exceeds Number.MAX_SAFE_INTEGER');
  }
  return durationMs;
}

function evaluateRuntime(
  runtime: WebGpuRuntimeCandidate,
  quantizationBits: number,
): RuntimeFeasibilityReport {
  const failureReasons = [
    runtime.supportsWebGPU ? null : 'webgpu-backend-missing',
    runtime.supportsLayerBoundary ? null : 'layer-boundary-export-missing',
    runtime.supportsCheckpointResume ? null : 'checkpoint-resume-missing',
    runtime.supportedQuantizationBits.includes(quantizationBits)
      ? null
      : `quantization-${quantizationBits}bit-unsupported`,
  ].filter((reason): reason is string => reason !== null);

  return {
    name: runtime.name,
    status: failureReasons.length === 0 ? 'pass' : 'fail',
    failureReasons,
  };
}

function evaluateParameterGate(parameterCountB: number) {
  const pass = parameterCountB >= 28 && parameterCountB <= 34;
  return {
    name: '30b-class-parameter-count',
    status: pass ? 'pass' as const : 'fail' as const,
    reason: pass
      ? 'model is inside the 30B-class validation band'
      : `expected 28B-34B, got ${parameterCountB}B`,
  };
}

function evaluateSegmentGate(segments: readonly SegmentArtifact[]) {
  const pass = segments.length > 0 && segments.every((segment, index) => (
    segment.index === index &&
    segment.layerStart <= segment.layerEnd &&
    (index === 0 || segment.layerStart === segments[index - 1].layerEnd + 1)
  ));
  return {
    name: 'segment-layer-boundaries',
    status: pass ? 'pass' as const : 'fail' as const,
    reason: pass
      ? 'contiguous layer segments with stable indexes are declared'
      : 'segments must be contiguous layer ranges with stable indexes',
  };
}

function evaluateQuantizationGate(quantizationBits: number) {
  const pass = quantizationBits <= 4;
  return {
    name: 'quantization-budget',
    status: pass ? 'pass' as const : 'fail' as const,
    reason: pass
      ? '4-bit-or-smaller quantization keeps segment artifacts in scope'
      : `${quantizationBits}-bit quantization is too large for the 30B WebGPU gate`,
  };
}

function evaluateMemoryGate(segments: readonly SegmentFeasibilityReport[]) {
  const failing = segments.filter((segment) => (
    !segment.fitsWorkerMemoryBudget || !segment.fitsDispatcherWorkerTelemetry
  ));
  return {
    name: 'segment-memory-budget',
    status: failing.length === 0 ? 'pass' as const : 'fail' as const,
    reason: failing.length === 0
      ? 'every segment fits both the manual worker budget and dispatcher telemetry'
      : `segments over budget: ${failing.map((segment) => segment.index).join(', ')}`,
  };
}

function evaluateLoadGate(assumptions: DispatcherAssumptions) {
  const overBudget = assumptions.gpuBusyRatio > assumptions.loadBudgetRatio ||
    assumptions.cpuBusyRatio > assumptions.loadBudgetRatio;
  return {
    name: 'adaptive-dispatcher-load-budget',
    status: overBudget ? 'fail' as const : 'pass' as const,
    reason: overBudget
      ? `worker load exceeds ${assumptions.loadBudgetRatio * 100}% dispatcher budget`
      : 'worker load remains inside the adaptive dispatcher budget',
  };
}

function evaluateCheckpointGate(checkpointTransferMs: number, maxCheckpointTransferMs: number) {
  const pass = checkpointTransferMs <= maxCheckpointTransferMs;
  return {
    name: 'checkpoint-transfer-budget',
    status: pass ? 'pass' as const : 'fail' as const,
    reason: pass
      ? 'checkpoint transfer estimate is inside the scale-up gate'
      : `${checkpointTransferMs}ms exceeds ${maxCheckpointTransferMs}ms transfer budget`,
  };
}

function evaluateRuntimeGate(runtimes: readonly RuntimeFeasibilityReport[]) {
  const passing = runtimes.filter((runtime) => runtime.status === 'pass');
  return {
    name: 'runtime-candidate',
    status: passing.length > 0 ? 'pass' as const : 'fail' as const,
    reason: passing.length > 0
      ? `${passing.map((runtime) => runtime.name).join(', ')} can run the partial-inference gate`
      : 'no runtime supports WebGPU, layer boundaries, checkpoint resume, and quantization',
  };
}
