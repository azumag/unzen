import { describe, expect, it } from 'vitest';
import {
  BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
  BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
  planSegmentArtifactBudget,
  verifyActualSegmentArtifactBudget,
} from '../browser-harness/webgpu-2b-split/artifact-budget.js';

describe('browser artifact verifier plan byte recomposition', () => {
  it('rejects unsafe graph/external recomposition before addition', () => {
    expect(() => verifyActualSegmentArtifactBudget({
      mode: 'p0',
      declaredBytes: 10,
      graphDeclaredBytes: Number.MAX_SAFE_INTEGER,
      externalDeclaredBytes: 1,
      requiredMaxBytes: BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
      absoluteMaxBytes: BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
      verdict: 'accepted',
    }, [])).toThrow('artifact plan graph/external byte breakdown must equal declaredBytes');
  });

  it('preserves valid exact recomposition', () => {
    const plan = planSegmentArtifactBudget({
      index: 0,
      browserArtifactBytes: 10,
      externalData: [{ bytes: 4 }],
    }, 'p0');

    expect(verifyActualSegmentArtifactBudget(plan, [{ bytes: 6 }, { bytes: 4 }])).toMatchObject({
      declaredBytes: 10,
      graphDeclaredBytes: 6,
      externalDeclaredBytes: 4,
      actualBytes: 10,
      verdict: 'accepted',
    });
  });
});
