import { describe, expect, it } from 'vitest';
import {
  argmaxLastLogits,
  validateCheckpointBoundaryNames,
} from '../browser-harness/webgpu-2b-split/runtime-validation.js';

function tensorWire(name: string, overrides: Record<string, unknown> = {}) {
  const bytes = 32;
  return {
    name,
    type: 'float32',
    dims: [1, 2, 4],
    bytes,
    base64: Buffer.alloc(bytes).toString('base64'),
    ...overrides,
  };
}

function checkpoint(tensors: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    inputTokenIds: [1, 2, 3],
    tensors,
    ...overrides,
  };
}

describe('browser split runtime validation', () => {
  const manifest = {
    boundary: {
      dtype: 'float32',
      tensors: [
        { name: 'boundary-a' },
        { name: 'boundary-b' },
      ],
    },
  };

  const validTensors = () => [tensorWire('boundary-a'), tensorWire('boundary-b')];

  it('accepts the exact manifest boundary tensors independent of relay order', () => {
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-b'),
      tensorWire('boundary-a'),
    ]), manifest)).not.toThrow();
  });

  it('rejects coercible or structurally invalid checkpoint input token IDs before continuation', () => {
    const invalidTokenIds = [
      [],
      ['1', 2],
      [true, 2],
      [null, 2],
      [-1, 2],
      [1.5, 2],
      [Number.MAX_SAFE_INTEGER + 1, 2],
      '1,2',
      null,
    ];
    for (const inputTokenIds of invalidTokenIds) {
      expect(() => validateCheckpointBoundaryNames(
        checkpoint(validTensors(), { inputTokenIds }),
        manifest,
      )).toThrow(/invalid input token IDs/);
    }
  });

  it('accepts zero and other non-negative safe integer checkpoint token IDs without normalization', () => {
    const inputTokenIds = [0, 1, Number.MAX_SAFE_INTEGER];
    const value = checkpoint(validTensors(), { inputTokenIds });
    expect(() => validateCheckpointBoundaryNames(value, manifest)).not.toThrow();
    expect(value.inputTokenIds).toEqual(inputTokenIds);
  });

  it('rejects duplicate, missing, unexpected, and oversized boundary names', () => {
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-a'), tensorWire('boundary-a'),
    ]), manifest)).toThrow(/duplicate/);
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-a'), tensorWire('other'),
    ]), manifest)).toThrow(/do not match manifest/);
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-a'),
    ]), manifest)).toThrow(/exactly two/);
    const oversizedName = 'x'.repeat(1025);
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire(oversizedName), tensorWire('boundary-b'),
    ]), {
      boundary: {
        dtype: 'float32',
        tensors: [{ name: oversizedName }, { name: 'boundary-b' }],
      },
    })).toThrow(/invalid boundary tensor name/);
  });

  it('rejects unsupported or manifest-mismatched boundary tensor types', () => {
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-a', { type: 'complex64' }),
      tensorWire('boundary-b'),
    ]), manifest)).toThrow(/unsupported type/);
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-a', {
        type: 'float64',
        bytes: 64,
        base64: Buffer.alloc(64).toString('base64'),
      }),
      tensorWire('boundary-b'),
    ]), manifest)).toThrow(/does not match manifest/);
  });

  it('rejects malformed, over-ranked, overflowing, and byte-inconsistent boundary tensor shapes', () => {
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-a', { dims: [1, 0, 4] }), tensorWire('boundary-b'),
    ]), manifest)).toThrow(/invalid dimension/);
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-a', { dims: new Array(9).fill(1) }), tensorWire('boundary-b'),
    ]), manifest)).toThrow(/invalid dims/);
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-a', { dims: [Number.MAX_SAFE_INTEGER, 2] }),
      tensorWire('boundary-b'),
    ]), manifest)).toThrow(/overflows/);
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-a', { bytes: 31 }), tensorWire('boundary-b'),
    ]), manifest)).toThrow(/declared byte length mismatch/);
  });

  it('rejects malformed or length-mismatched base64 before reconstruction', () => {
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-a', { base64: '!!!!' }), tensorWire('boundary-b'),
    ]), manifest)).toThrow(/invalid base64/);
    expect(() => validateCheckpointBoundaryNames(checkpoint([
      tensorWire('boundary-a', { base64: Buffer.alloc(28).toString('base64') }),
      tensorWire('boundary-b'),
    ]), manifest)).toThrow(/encoded byte length mismatch/);
  });

  it('rejects an unsupported manifest boundary dtype before trusting relay tensors', () => {
    expect(() => validateCheckpointBoundaryNames(checkpoint(validTensors()), {
      boundary: {
        dtype: 'complex64',
        tensors: manifest.boundary.tensors,
      },
    })).toThrow(/supported boundary dtype/);
  });

  it('returns the final-position argmax for finite logits', () => {
    const result = argmaxLastLogits({
      type: 'float32',
      dims: [1, 2, 3],
      data: new Float32Array([9, 8, 7, -1, 4, 2]),
    });
    expect(result).toEqual({ tokenId: 1, logit: 4, elementCount: 6 });
  });

  it.each([
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, '+Infinity'],
    [Number.NEGATIVE_INFINITY, '-Infinity'],
  ])('rejects non-finite logits (%s)', (invalid) => {
    expect(() => argmaxLastLogits({
      type: 'float32',
      dims: [1, 1, 3],
      data: new Float32Array([1, invalid, 2]),
    })).toThrow(/non-finite logit/);
  });

  it('rejects empty logits dimensions and data-length mismatches', () => {
    expect(() => argmaxLastLogits({
      type: 'float32',
      dims: [1, 0, 3],
      data: new Float32Array([]),
    })).toThrow(/unexpected logits shape/);
    expect(() => argmaxLastLogits({
      type: 'float32',
      dims: [1, 2, 3],
      data: new Float32Array([1, 2, 3]),
    })).toThrow(/data length mismatch/);
  });
});
