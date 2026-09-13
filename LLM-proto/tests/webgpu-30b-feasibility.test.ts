import { describe, expect, it } from 'vitest';
import {
  createDefault30BFeasibilityManifest,
  evaluateWebGpu30BFeasibility,
  type WebGpu30BFeasibilityManifest,
} from '../src/webgpu-30b-feasibility.js';

describe('WebGPU 30B partial inference feasibility gate', () => {
  it('passes the default 30B-class q4 example metadata gate and reports scale-up measurements', () => {
    const report = evaluateWebGpu30BFeasibility(createDefault30BFeasibilityManifest());

    expect(report.status).toBe('pass');
    expect(report.modelId).toBe('unzen-30b-q4-8seg-example');
    expect(report.modelRevision).toBe('rev-2026-08-01');
    expect(report.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.segmentCount).toBe(8);
    expect(report.quantizationBits).toBe(4);
    expect(report.checkpointTensorShape).toEqual([1, 512, 6656]);
    expect(report.checkpointBytes).toBe(6_815_744);
    expect(report.checkpointTransferMs).toBe(407);
    expect(report.segments.every((segment) => segment.fitsWorkerMemoryBudget)).toBe(true);
    expect(report.segments.every((segment) => segment.fitsDispatcherWorkerTelemetry)).toBe(true);
    expect(report.runtimes.find((runtime) => runtime.name === 'webllm')).toMatchObject({
      status: 'pass',
      failureReasons: [],
    });
    expect(report.scaleUpGates).toContainEqual({
      name: 'runtime-candidate',
      status: 'pass',
      reason: 'webllm can run the partial-inference gate',
    });
  });

  it('rejects malformed top-level and nested runtime containers before metadata arithmetic', () => {
    const malformedTopLevels: unknown[] = [null, undefined, 42, 'manifest', Symbol('manifest'), []];
    for (const malformed of malformedTopLevels) {
      expect(() => evaluateWebGpu30BFeasibility(
        malformed as WebGpu30BFeasibilityManifest,
      )).toThrow('WebGPU feasibility manifest must be an object');
    }

    const base = createDefault30BFeasibilityManifest();
    expect(() => evaluateWebGpu30BFeasibility({
      ...base,
      checkpointTensor: null,
    } as unknown as WebGpu30BFeasibilityManifest)).toThrow('checkpointTensor must be an object');
    expect(() => evaluateWebGpu30BFeasibility({
      ...base,
      dispatcherAssumptions: [],
    } as unknown as WebGpu30BFeasibilityManifest)).toThrow('dispatcherAssumptions must be an object');
    expect(() => evaluateWebGpu30BFeasibility({
      ...base,
      runtimeCandidates: {},
    } as unknown as WebGpu30BFeasibilityManifest)).toThrow('runtimeCandidates must be an array');
    expect(() => evaluateWebGpu30BFeasibility({
      ...base,
      model: { ...base.model, segments: {} },
    } as unknown as WebGpu30BFeasibilityManifest)).toThrow('model.segments must be an array');
  });

  it('rejects malformed scalar metadata before NaN or Infinity can enter the report', () => {
    const base = createDefault30BFeasibilityManifest();

    expect(() => evaluateWebGpu30BFeasibility({
      ...base,
      dispatcherAssumptions: {
        ...base.dispatcherAssumptions,
        checkpointBytesPerSecond: Number.NaN,
      },
    })).toThrow('dispatcherAssumptions.checkpointBytesPerSecond must be a positive finite number');

    expect(() => evaluateWebGpu30BFeasibility({
      ...base,
      model: {
        ...base.model,
        segments: base.model.segments.map((segment, index) => index === 0
          ? { ...segment, estimatedMemoryMB: Number.POSITIVE_INFINITY }
          : segment),
      },
    })).toThrow('model.segments[0].estimatedMemoryMB must be a positive finite number');

    expect(() => evaluateWebGpu30BFeasibility({
      ...base,
      runtimeCandidates: base.runtimeCandidates.map((runtime, index) => index === 0
        ? { ...runtime, supportedQuantizationBits: null }
        : runtime),
    } as unknown as WebGpu30BFeasibilityManifest)).toThrow(
      'runtimeCandidates[0].supportedQuantizationBits must be an array',
    );
  });

  it('rejects checkpoint arithmetic that exceeds safe integer precision', () => {
    const base = createDefault30BFeasibilityManifest();
    expect(() => evaluateWebGpu30BFeasibility({
      ...base,
      checkpointTensor: {
        ...base.checkpointTensor,
        batchSize: Number.MAX_SAFE_INTEGER,
      },
    })).toThrow('checkpoint tensor element count exceeds Number.MAX_SAFE_INTEGER');
  });

  it('returns actionable failure reasons when the manifest cannot advance to WebGPU 30B', () => {
    const base = createDefault30BFeasibilityManifest();
    const manifest: WebGpu30BFeasibilityManifest = {
      ...base,
      model: {
        ...base.model,
        quantization: 'q8',
        segments: base.model.segments.map((segment, index) => ({
          ...segment,
          estimatedMemoryMB: index === 3 ? 5200 : segment.estimatedMemoryMB,
        })),
      },
      dispatcherAssumptions: {
        ...base.dispatcherAssumptions,
        workerVramFreeMB: 4096,
        gpuBusyRatio: 0.05,
        checkpointBytesPerSecond: 2 * 1024 * 1024,
      },
      runtimeCandidates: base.runtimeCandidates.map((runtime) => ({
        ...runtime,
        supportsCheckpointResume: false,
      })),
    };

    const report = evaluateWebGpu30BFeasibility(manifest);

    expect(report.status).toBe('fail');
    expect(report.checkpointTransferMs).toBe(3250);
    expect(report.segments[3]).toMatchObject({
      index: 3,
      fitsWorkerMemoryBudget: false,
      fitsDispatcherWorkerTelemetry: false,
    });
    expect(report.failureReasons).toEqual([
      'quantization-budget: 8-bit quantization is too large for the 30B WebGPU gate',
      'segment-memory-budget: segments over budget: 3',
      'adaptive-dispatcher-load-budget: worker load exceeds 3% dispatcher budget',
      'checkpoint-transfer-budget: 3250ms exceeds 750ms transfer budget',
      'runtime-candidate: no runtime supports WebGPU, layer boundaries, checkpoint resume, and quantization',
    ]);
    expect(report.runtimes.every((runtime) => runtime.status === 'fail')).toBe(true);
  });

  it('rejects non-contiguous layer boundaries before manual browser validation', () => {
    const base = createDefault30BFeasibilityManifest();
    const report = evaluateWebGpu30BFeasibility({
      ...base,
      model: {
        ...base.model,
        segments: base.model.segments.map((segment, index) => index === 4
          ? { ...segment, layerStart: segment.layerStart + 1 }
          : segment),
      },
    });

    expect(report.status).toBe('fail');
    expect(report.failureReasons).toContain(
      'segment-layer-boundaries: segments must be contiguous layer ranges with stable indexes',
    );
  });
});
