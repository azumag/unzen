import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { validateModelManifestShape } from '../src/model-manifest-validator.js';

interface GeometrySegment {
  readonly index: number;
  readonly layerStart: number;
  readonly layerEnd: number;
}

interface ManifestGeometrySegment {
  readonly index: unknown;
  readonly layerStart: unknown;
  readonly layerEnd: unknown;
}

interface WasmGeometryResult {
  readonly status: 'valid' | 'invalid';
  readonly reason?: string | null;
  readonly reasonCode?: number;
  readonly wasmCalled: boolean;
  readonly moduleType: string;
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(projectRoot, 'worker-runtime', 'segment-geometry-wasm-worker.mjs');
const wasmPath = join(projectRoot, 'worker-runtime', 'wasm-fixtures', 'segment-geometry.wasm');
const COMPATIBILITY_DATE = '2026-08-06';
const I32_MAX = 0x7fffffff;
const WASM_BYTES = 109;
const WASM_SHA256 = '6f311dd115e63448a0e0bf11b12fa29cc1c851112f38732b58ceebc09ba548aa';

function createRuntime(): Miniflare {
  return new Miniflare({
    modules: true,
    modulesRoot: projectRoot,
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    scriptPath,
    compatibilityDate: COMPATIBILITY_DATE,
  });
}

function manifestFor(
  totalLayers: unknown,
  segments: readonly ManifestGeometrySegment[],
): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    modelId: 'segment-geometry-differential-fixture',
    modelRevision: 'issue-306',
    architecture: 'FixtureForCausalLM',
    parameterCount: 1,
    quantization: 'q4',
    totalLayers,
    tokenizer: 'fixture-tokenizer',
    checkpointFormat: 'fixture-hidden-state-v1',
    runtimeRequirements: {
      minimumVramMB: 1,
      supportedQuantization: ['q4'],
      minimumRuntimeVersion: '1.0.0',
      minimumChromeVersion: '128',
    },
    manifestDigest: 'b'.repeat(64),
    source: 'fixture',
    segments: segments.map((segment, arrayIndex) => ({
      index: segment.index,
      layerStart: segment.layerStart,
      layerEnd: segment.layerEnd,
      byteSize: 1,
      sha256: String.fromCharCode(97 + (arrayIndex % 6)).repeat(64),
      contentType: 'application/octet-stream',
      artifactLocator: `https://fixture.invalid/segment-${arrayIndex}.bin`,
      estimatedMemoryMB: 1,
      memoryBasis: 'estimated',
      compatibleRuntimes: ['fixture-runtime'],
      minimumRuntimeVersion: '1.0.0',
    })),
  };
}

function referenceValid(totalLayers: number, segments: readonly GeometrySegment[]): boolean {
  return validateModelManifestShape(manifestFor(totalLayers, segments)).status === 'valid';
}

async function wasmResult(
  mf: Miniflare,
  totalLayers: number,
  segments: readonly GeometrySegment[],
): Promise<WasmGeometryResult> {
  const response = await mf.dispatchFetch('https://segment-geometry.internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ totalLayers, segments }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as WasmGeometryResult;
}

const curatedCases: ReadonlyArray<{
  readonly name: string;
  readonly totalLayers: number;
  readonly segments: readonly GeometrySegment[];
}> = [
  {
    name: 'single segment covers the complete model',
    totalLayers: 4,
    segments: [{ index: 0, layerStart: 0, layerEnd: 3 }],
  },
  {
    name: 'multiple contiguous segments cover the complete model',
    totalLayers: 6,
    segments: [
      { index: 0, layerStart: 0, layerEnd: 1 },
      { index: 1, layerStart: 2, layerEnd: 3 },
      { index: 2, layerStart: 4, layerEnd: 5 },
    ],
  },
  {
    name: 'input order may be shuffled because index order is canonical',
    totalLayers: 6,
    segments: [
      { index: 2, layerStart: 4, layerEnd: 5 },
      { index: 0, layerStart: 0, layerEnd: 1 },
      { index: 1, layerStart: 2, layerEnd: 3 },
    ],
  },
  {
    name: 'duplicate index',
    totalLayers: 4,
    segments: [
      { index: 0, layerStart: 0, layerEnd: 1 },
      { index: 0, layerStart: 2, layerEnd: 3 },
    ],
  },
  {
    name: 'missing index',
    totalLayers: 4,
    segments: [
      { index: 0, layerStart: 0, layerEnd: 1 },
      { index: 2, layerStart: 2, layerEnd: 3 },
    ],
  },
  {
    name: 'layer overlap',
    totalLayers: 4,
    segments: [
      { index: 0, layerStart: 0, layerEnd: 2 },
      { index: 1, layerStart: 2, layerEnd: 3 },
    ],
  },
  {
    name: 'layer gap',
    totalLayers: 5,
    segments: [
      { index: 0, layerStart: 0, layerEnd: 1 },
      { index: 1, layerStart: 3, layerEnd: 4 },
    ],
  },
  {
    name: 'first layer is not zero',
    totalLayers: 4,
    segments: [{ index: 0, layerStart: 1, layerEnd: 3 }],
  },
  {
    name: 'last layer does not reach totalLayers minus one',
    totalLayers: 4,
    segments: [{ index: 0, layerStart: 0, layerEnd: 2 }],
  },
  {
    name: 'reversed range inside the numeric domain',
    totalLayers: 4,
    segments: [
      { index: 0, layerStart: 0, layerEnd: 1 },
      { index: 1, layerStart: 2, layerEnd: 1 },
    ],
  },
  {
    name: 'inclusive one-layer range is valid under current semantics',
    totalLayers: 1,
    segments: [{ index: 0, layerStart: 0, layerEnd: 0 }],
  },
  {
    name: 'layer outside model range',
    totalLayers: 4,
    segments: [{ index: 0, layerStart: 0, layerEnd: 4 }],
  },
  {
    name: 'largest in-domain totalLayers is representable without wraparound',
    totalLayers: I32_MAX,
    segments: [{ index: 0, layerStart: 0, layerEnd: I32_MAX - 1 }],
  },
];

describe('segment geometry JS/Wasm differential spike', () => {
  it('pins the reviewable Wasm binary identity', async () => {
    const bytes = await readFile(wasmPath);
    expect(bytes.byteLength).toBe(WASM_BYTES);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(WASM_SHA256);
  });

  it('matches current validateModelManifestShape geometry semantics on curated vectors', async () => {
    const mf = createRuntime();
    try {
      await mf.ready;
      for (const vector of curatedCases) {
        const expected = referenceValid(vector.totalLayers, vector.segments);
        const actual = await wasmResult(mf, vector.totalLayers, vector.segments);
        expect(actual.moduleType, vector.name).toBe('WebAssembly.Module');
        expect(actual.status === 'valid', vector.name).toBe(expected);
      }
    } finally {
      await mf.dispose();
    }
  });

  it('returns deterministic compact reason codes for each Wasm geometry branch', async () => {
    const mf = createRuntime();
    try {
      await mf.ready;
      const cases: ReadonlyArray<{
        readonly reasonCode: number;
        readonly totalLayers: number;
        readonly segments: readonly GeometrySegment[];
      }> = [
        {
          reasonCode: 1,
          totalLayers: 4,
          segments: [{ index: 1, layerStart: 0, layerEnd: 3 }],
        },
        {
          reasonCode: 2,
          totalLayers: 4,
          segments: [
            { index: 0, layerStart: 0, layerEnd: 1 },
            { index: 1, layerStart: 3, layerEnd: 3 },
          ],
        },
        {
          reasonCode: 3,
          totalLayers: 4,
          segments: [
            { index: 0, layerStart: 0, layerEnd: 1 },
            { index: 1, layerStart: 2, layerEnd: 1 },
          ],
        },
        {
          reasonCode: 4,
          totalLayers: 4,
          segments: [{ index: 0, layerStart: 0, layerEnd: 4 }],
        },
        {
          reasonCode: 5,
          totalLayers: 4,
          segments: [{ index: 0, layerStart: 0, layerEnd: 2 }],
        },
      ];

      for (const vector of cases) {
        const actual = await wasmResult(mf, vector.totalLayers, vector.segments);
        expect(actual.status).toBe('invalid');
        expect(actual.reasonCode).toBe(vector.reasonCode);
        expect(actual.wasmCalled).toBe(true);
      }
    } finally {
      await mf.dispose();
    }
  });

  it('matches the JS reference across deterministic seeded integer vectors', async () => {
    const mf = createRuntime();
    let state = 0x3062026;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };

    try {
      await mf.ready;
      for (let sample = 0; sample < 64; sample += 1) {
        const totalLayers = 1 + (next() % 16);
        const count = 1 + (next() % 4);
        const segments: GeometrySegment[] = [];
        for (let index = 0; index < count; index += 1) {
          segments.push({
            index: next() % (count + 2),
            layerStart: next() % (totalLayers + 2),
            layerEnd: next() % (totalLayers + 2),
          });
        }

        const expected = referenceValid(totalLayers, segments);
        const actual = await wasmResult(mf, totalLayers, segments);
        expect(actual.status === 'valid', `seeded sample ${sample}`).toBe(expected);
      }
    } finally {
      await mf.dispose();
    }
  });

  it('fails closed before Wasm for values outside the chosen non-negative i32 domain', async () => {
    const mf = createRuntime();
    try {
      await mf.ready;
      for (const vector of [
        { totalLayers: I32_MAX + 1, segments: [{ index: 0, layerStart: 0, layerEnd: I32_MAX }] },
        { totalLayers: 4, segments: [{ index: -1, layerStart: 0, layerEnd: 3 }] },
        { totalLayers: 4, segments: [{ index: 0, layerStart: 0.5, layerEnd: 3 }] },
      ]) {
        const actual = await wasmResult(mf, vector.totalLayers, vector.segments);
        expect(actual).toMatchObject({
          status: 'invalid',
          reason: 'numeric-domain',
          wasmCalled: false,
          moduleType: 'WebAssembly.Module',
        });
      }
    } finally {
      await mf.dispose();
    }
  });

  it('keeps structural malformed values in the existing JavaScript validator boundary', () => {
    for (const malformed of [Number.NaN, Number.POSITIVE_INFINITY, '0', undefined]) {
      const manifest = manifestFor(4, [
        { index: 0, layerStart: malformed, layerEnd: 3 },
      ]);
      const result = validateModelManifestShape(manifest);
      expect(result.status).toBe('invalid');
      expect(result.issues.some((item) => item.code === 'invalid-layer-range')).toBe(true);
    }
  });
});
