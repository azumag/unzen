import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateEndpointEmbeddingWebGpuTileDeviceBudget } from '../tools/verify_endpoint_embedding_webgpu_tile_device_budget.mjs';

const MAX_TILE_BYTES = 131_334_144;

describe('endpoint embedding WebGPU execution-tile device budget', () => {
  it('accepts the pinned 125.25 MiB tile at the WebGPU default 128 MiB storage-binding limit', () => {
    const analysis = evaluateEndpointEmbeddingWebGpuTileDeviceBudget({
      maxBufferSize: 268_435_456,
      maxStorageBufferBindingSize: 134_217_728,
    });

    expect(analysis).toMatchObject({
      status: 'pass',
      decisionStatus: 'diagnostic-only',
      physicalArtifactCount: 4,
      executionTileCount: 8,
      maximumPhysicalArtifactBytes: 262_668_288,
      maximumExecutionTileBytes: MAX_TILE_BYTES,
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

  it('accepts an adapter exactly at the largest execution-tile boundary', () => {
    const analysis = evaluateEndpointEmbeddingWebGpuTileDeviceBudget({
      maxBufferSize: MAX_TILE_BYTES,
      maxStorageBufferBindingSize: MAX_TILE_BYTES,
    });
    expect(analysis.status).toBe('pass');
    expect(analysis.checks.maxBufferSize.headroomBytes).toBe(0);
    expect(analysis.checks.maxStorageBufferBindingSize.headroomBytes).toBe(0);
  });

  it('reports failure rather than treating a physical-artifact limit as the execution-tile limit', () => {
    const analysis = evaluateEndpointEmbeddingWebGpuTileDeviceBudget({
      maxBufferSize: 262_668_288,
      maxStorageBufferBindingSize: MAX_TILE_BYTES - 1,
    });
    expect(analysis.status).toBe('fail');
    expect(analysis.maximumPhysicalArtifactBytes).toBeGreaterThan(analysis.maximumExecutionTileBytes);
    expect(analysis.checks.maxStorageBufferBindingSize).toEqual({
      availableBytes: MAX_TILE_BYTES - 1,
      requiredBytes: MAX_TILE_BYTES,
      headroomBytes: -1,
      pass: false,
    });
  });

  it.each([
    ['missing maxBufferSize', { maxStorageBufferBindingSize: MAX_TILE_BYTES }],
    ['zero storage-binding limit', { maxBufferSize: MAX_TILE_BYTES, maxStorageBufferBindingSize: 0 }],
    ['fractional buffer limit', { maxBufferSize: MAX_TILE_BYTES + 0.5, maxStorageBufferBindingSize: MAX_TILE_BYTES }],
  ])('rejects malformed captured adapter limits: %s', (_label, limits) => {
    expect(() => evaluateEndpointEmbeddingWebGpuTileDeviceBudget(limits)).toThrow('positive safe integer');
  });
});

it('keeps persisted device-budget verification behind the primary captured-evidence validator and stable reader', () => {
  const source = readFileSync(
    new URL('../tools/verify_endpoint_embedding_webgpu_tile_device_budget.mjs', import.meta.url),
    'utf8',
  );
  const readIndex = source.indexOf("readStableRegularUtf8File(evidencePath, 'captured endpoint embedding evidence')");
  const primaryValidationIndex = source.indexOf('validateCapturedEndpointEmbeddingRuntimeEvidence(evidence)');
  const budgetIndex = source.indexOf('evaluateEndpointEmbeddingWebGpuTileDeviceBudget(evidence.adapterLimits)');
  expect(readIndex).toBeGreaterThan(-1);
  expect(primaryValidationIndex).toBeGreaterThan(readIndex);
  expect(budgetIndex).toBeGreaterThan(primaryValidationIndex);
  expect(source).toContain("decisionStatus: 'diagnostic-only'");
  expect(source).toContain('does not prove ORT GPU-device limit negotiation');
});
