import type { SegmentConfig } from './types.js';

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

export interface WebGpu30BFeasibilityManifest {
  readonly modelId: string;
  readonly parameterCountB: number;
  readonly quantizationBits: number;
  readonly segments: readonly SegmentConfig[];
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

export function evaluateWebGpu30BFeasibility(
  manifest: WebGpu30BFeasibilityManifest,
): WebGpu30BFeasibilityReport {
  const checkpointTensorShape = [
    manifest.checkpointTensor.batchSize,
    manifest.checkpointTensor.sequenceLength,
    manifest.checkpointTensor.hiddenSize,
  ] as const;
  const checkpointBytes = checkpointTensorShape.reduce((total, value) => total * value, 1) *
    BYTES_PER_DTYPE[manifest.checkpointTensor.dtype];
  const checkpointTransferMs = Math.ceil(
    (checkpointBytes / manifest.dispatcherAssumptions.checkpointBytesPerSecond) * 1000,
  );
  const segments = manifest.segments.map((segment) => ({
    index: segment.index,
    layerStart: segment.layerStart,
    layerEnd: segment.layerEnd,
    estimatedVramMB: segment.estimatedVramMB,
    fitsWorkerMemoryBudget: segment.estimatedVramMB <= manifest.workerMemoryBudgetMB,
    fitsDispatcherWorkerTelemetry: segment.estimatedVramMB <=
      manifest.dispatcherAssumptions.workerVramFreeMB,
  }));
  const runtimes = manifest.runtimeCandidates.map((runtime) => evaluateRuntime(
    runtime,
    manifest.quantizationBits,
  ));
  const scaleUpGates = [
    evaluateParameterGate(manifest.parameterCountB),
    evaluateSegmentGate(manifest.segments),
    evaluateQuantizationGate(manifest.quantizationBits),
    evaluateMemoryGate(segments),
    evaluateLoadGate(manifest.dispatcherAssumptions),
    evaluateCheckpointGate(checkpointTransferMs, manifest.maxCheckpointTransferMs),
    evaluateRuntimeGate(runtimes),
  ];
  const failureReasons = scaleUpGates
    .filter((gate) => gate.status === 'fail')
    .map((gate) => `${gate.name}: ${gate.reason}`);

  return {
    modelId: manifest.modelId,
    status: failureReasons.length === 0 ? 'pass' : 'fail',
    segmentCount: manifest.segments.length,
    quantizationBits: manifest.quantizationBits,
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
    modelId: 'unzen-30b-q4-8seg-feasibility',
    parameterCountB: 30,
    quantizationBits: 4,
    segments: Array.from({ length: 8 }, (_, index) => ({
      index,
      layerStart: index * 8,
      layerEnd: (index + 1) * 8 - 1,
      modelWeightHash: `sha256:30b-q4-seg-${index}`,
      estimatedVramMB: 2100,
    })),
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

function evaluateSegmentGate(segments: readonly SegmentConfig[]) {
  const pass = segments.length === 8 && segments.every((segment, index) => (
    segment.index === index &&
    segment.layerStart <= segment.layerEnd &&
    (index === 0 || segment.layerStart === segments[index - 1].layerEnd + 1)
  ));
  return {
    name: 'segment-layer-boundaries',
    status: pass ? 'pass' as const : 'fail' as const,
    reason: pass
      ? '8 contiguous layer segments are declared'
      : 'segments must be 8 contiguous layer ranges with stable indexes',
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
