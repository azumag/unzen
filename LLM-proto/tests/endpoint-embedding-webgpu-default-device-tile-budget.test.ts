import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateEndpointEmbeddingWebGpuDefaultDeviceTileBudget } from '../tools/preflight_endpoint_embedding_webgpu_capture.mjs';

const MAX_TILE_BYTES = 131_334_144;

function hostProbe(deviceLimits: Record<string, number>) {
  return { deviceLimits };
}

describe('endpoint embedding WebGPU default-device tile-budget diagnostic', () => {
  it('reports the default 128 MiB storage-binding headroom without turning the result into a gate', () => {
    const analysis = evaluateEndpointEmbeddingWebGpuDefaultDeviceTileBudget(hostProbe({
      maxBufferSize: 268_435_456,
      maxStorageBufferBindingSize: 134_217_728,
    }));

    expect(analysis).toMatchObject({
      status: 'pass',
      decisionStatus: 'diagnostic-only',
      kind: 'unzen-endpoint-embedding-webgpu-default-device-tile-budget',
      schemaVersion: '1.0.0',
      maximumExecutionTileBytes: MAX_TILE_BYTES,
      gating: false,
      checks: {
        maxBufferSize: {
          availableBytes: 268_435_456,
          requiredBytes: MAX_TILE_BYTES,
          headroomBytes: 137_101_312,
          pass: true,
        },
        maxStorageBufferBindingSize: {
          availableBytes: 134_217_728,
          requiredBytes: MAX_TILE_BYTES,
          headroomBytes: 2_883_584,
          pass: true,
        },
      },
    });
  });

  it('reports a sub-tile default device limit as non-gating failure', () => {
    const analysis = evaluateEndpointEmbeddingWebGpuDefaultDeviceTileBudget(hostProbe({
      maxBufferSize: MAX_TILE_BYTES,
      maxStorageBufferBindingSize: MAX_TILE_BYTES - 1,
    }));

    expect(analysis.status).toBe('fail');
    expect(analysis.gating).toBe(false);
    expect(analysis.checks.maxBufferSize).toMatchObject({ headroomBytes: 0, pass: true });
    expect(analysis.checks.maxStorageBufferBindingSize).toMatchObject({ headroomBytes: -1, pass: false });
    expect(analysis.conclusion).toContain('does not fail preflight');
    expect(analysis.conclusion).toContain('ONNX Runtime Web creates its own GPUDevice');
  });

  it.each([
    ['missing deviceLimits', {}],
    ['array deviceLimits', { deviceLimits: [] }],
    ['zero maxBufferSize', { deviceLimits: { maxBufferSize: 0, maxStorageBufferBindingSize: MAX_TILE_BYTES } }],
    ['fractional maxStorageBufferBindingSize', { deviceLimits: { maxBufferSize: MAX_TILE_BYTES, maxStorageBufferBindingSize: 1.5 } }],
  ])('fails closed on malformed host-probe input: %s', (_name, probe) => {
    expect(() => evaluateEndpointEmbeddingWebGpuDefaultDeviceTileBudget(probe)).toThrow();
  });

  it('computes the diagnostic before hashing the prepared graph/payload bundle', () => {
    const source = readFileSync(
      new URL('../tools/preflight_endpoint_embedding_webgpu_capture.mjs', import.meta.url),
      'utf8',
    );
    const diagnostic = source.indexOf('const defaultDeviceTileBudget = evaluateEndpointEmbeddingWebGpuDefaultDeviceTileBudget(hostProbe)');
    const graphHashing = source.indexOf('for (const [variantName, variant] of Object.entries(EXPECTED.graphVariants))');
    const payloadHashing = source.indexOf('for (const artifact of EXPECTED.physicalArtifacts)');

    expect(diagnostic).toBeGreaterThan(-1);
    expect(graphHashing).toBeGreaterThan(diagnostic);
    expect(payloadHashing).toBeGreaterThan(graphHashing);
    expect(source).toContain('defaultDeviceTileBudget,');
  });
});
