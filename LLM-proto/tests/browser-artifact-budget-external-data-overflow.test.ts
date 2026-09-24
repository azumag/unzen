import { describe, expect, it } from 'vitest';
import {
  planSegmentArtifactBudget,
} from '../browser-harness/webgpu-2b-split/artifact-budget.js';

describe('browser artifact planner cumulative external-data byte arithmetic', () => {
  it('rejects cumulative overflow before deriving graph bytes', () => {
    expect(() => planSegmentArtifactBudget({
      index: 0,
      browserArtifactBytes: 10,
      externalData: [
        { bytes: Number.MAX_SAFE_INTEGER },
        { bytes: 1 },
      ],
    }, 'p0')).toThrow('segment 0 cumulative external-data bytes exceed safe integer range');
  });

  it('preserves exact normal external-data totals', () => {
    expect(planSegmentArtifactBudget({
      index: 0,
      browserArtifactBytes: 10,
      externalData: [{ bytes: 4 }],
    }, 'p0')).toMatchObject({
      declaredBytes: 10,
      graphDeclaredBytes: 6,
      externalDeclaredBytes: 4,
      verdict: 'accepted',
    });
  });
});
