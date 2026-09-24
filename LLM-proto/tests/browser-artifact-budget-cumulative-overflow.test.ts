import { describe, expect, it } from 'vitest';
import {
  planSegmentArtifactBudget,
  verifyActualSegmentArtifactBudget,
} from '../browser-harness/webgpu-2b-split/artifact-budget.js';

function plan() {
  return planSegmentArtifactBudget({
    index: 0,
    browserArtifactBytes: 10,
    externalData: [{ bytes: 4 }],
  }, 'p0');
}

describe('browser artifact report cumulative byte arithmetic', () => {
  it('rejects cumulative overflow even when each report byte count is individually safe', () => {
    expect(() => verifyActualSegmentArtifactBudget(plan(), [
      { bytes: Number.MAX_SAFE_INTEGER },
      { bytes: 1 },
    ])).toThrow('artifact report cumulative bytes exceed safe integer range');
  });

  it('preserves exact accepted totals', () => {
    expect(verifyActualSegmentArtifactBudget(plan(), [
      { bytes: 6 },
      { bytes: 4 },
    ])).toMatchObject({
      actualBytes: 10,
      actualMatchesDeclared: true,
      verdict: 'accepted',
    });
  });
});
