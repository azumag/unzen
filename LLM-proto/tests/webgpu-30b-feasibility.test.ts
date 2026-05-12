import { describe, expect, it } from 'vitest';
import {
  createDefault30BFeasibilityManifest,
  evaluateWebGpu30BFeasibility,
  type WebGpu30BFeasibilityManifest,
} from '../src/webgpu-30b-feasibility.js';

describe('WebGPU 30B partial inference feasibility gate', () => {
  it('passes the default 30B-class q4 metadata gate and reports scale-up measurements', () => {
    const report = evaluateWebGpu30BFeasibility(createDefault30BFeasibilityManifest());

    expect(report.status).toBe('pass');
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

  it('returns actionable failure reasons when the manifest cannot advance to WebGPU 30B', () => {
    const base = createDefault30BFeasibilityManifest();
    const manifest: WebGpu30BFeasibilityManifest = {
      ...base,
      quantizationBits: 8,
      segments: base.segments.map((segment, index) => ({
        ...segment,
        estimatedVramMB: index === 3 ? 5200 : segment.estimatedVramMB,
      })),
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
      segments: base.segments.map((segment, index) => index === 4
        ? { ...segment, layerStart: segment.layerStart + 1 }
        : segment),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReasons).toContain(
      'segment-layer-boundaries: segments must be 8 contiguous layer ranges with stable indexes',
    );
  });
});
