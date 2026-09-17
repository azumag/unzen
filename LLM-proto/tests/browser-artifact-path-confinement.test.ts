import { describe, expect, it } from 'vitest';
import {
  requireSafeArtifactRelativePath,
} from '../browser-harness/webgpu-2b-split/artifact-path.js';
import {
  planSegmentArtifactBudget,
} from '../browser-harness/webgpu-2b-split/artifact-budget.js';

function segment(path = 'graphs/segment0.onnx', location = 'weights/segment0.onnx_data') {
  return {
    index: 0,
    path,
    browserArtifactBytes: 10,
    externalData: [{ location, bytes: 4 }],
  };
}

describe('browser split artifact path confinement', () => {
  it.each([
    '../outside.onnx',
    './segment0.onnx',
    'graphs//segment0.onnx',
    '/absolute/segment0.onnx',
    'C:/segment0.onnx',
    'graphs\\segment0.onnx',
    'graphs/../segment0.onnx',
    'graphs/PRN.bin',
    'graphs/weights.',
    'graphs/weights ',
    'graphs/segment0.onnx?raw=1',
    'graphs/segment0.onnx#fragment',
    'graphs/%2e%2e/segment0.onnx',
  ])('rejects graph path %s before runtime loading', (path) => {
    expect(() => planSegmentArtifactBudget(segment(path), 'p0')).toThrow(
      /segment 0 path must be a browser-safe relative POSIX path/,
    );
  });

  it.each([
    '../outside.bin',
    'weights/../outside.bin',
    'weights\\chunk.bin',
    'weights/NUL.data',
    'weights/chunk.bin?download=1',
    'weights/%2e%2e/chunk.bin',
  ])('rejects external-data location %s before runtime loading', (location) => {
    expect(() => planSegmentArtifactBudget(segment(undefined, location), 'p0')).toThrow(
      /segment 0 externalData\[0\]\.location must be a browser-safe relative POSIX path/,
    );
  });

  it('preserves ordinary nested relative artifact paths', () => {
    expect(requireSafeArtifactRelativePath('graphs/revision-1/segment0.onnx')).toBe(
      'graphs/revision-1/segment0.onnx',
    );
    expect(planSegmentArtifactBudget(segment(), 'p0')).toMatchObject({
      declaredBytes: 10,
      graphDeclaredBytes: 6,
      externalDeclaredBytes: 4,
      verdict: 'accepted',
    });
  });

  it('keeps the standalone budget helper compatible when locator fields are absent', () => {
    expect(planSegmentArtifactBudget({
      index: 0,
      browserArtifactBytes: 10,
      externalData: [{ bytes: 4 }],
    }, 'p0')).toMatchObject({
      declaredBytes: 10,
      graphDeclaredBytes: 6,
      externalDeclaredBytes: 4,
    });
  });
});
