import { describe, expect, it } from 'vitest';
import {
  BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
  BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
  planSegmentArtifactBudget,
  verifyActualSegmentArtifactBudget,
} from '../browser-harness/webgpu-2b-split/artifact-budget.js';

function validPlan() {
  return planSegmentArtifactBudget({
    index: 0,
    browserArtifactBytes: 10,
    externalData: [{ bytes: 4 }],
  }, 'p0');
}

describe('browser artifact budget plan integrity', () => {
  it('rejects forged absolute limits before reading artifact reports', () => {
    const plan = validPlan();
    let reportReads = 0;
    const reports = [{
      get bytes() {
        reportReads += 1;
        return 10;
      },
    }];

    expect(() => verifyActualSegmentArtifactBudget({
      ...plan,
      absoluteMaxBytes: BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES + 1,
    }, reports)).toThrow(
      'artifact plan absoluteMaxBytes must match the runtime absolute browser artifact limit',
    );

    expect(reportReads).toBe(0);
  });

  it('binds requiredMaxBytes to the declared budget mode', () => {
    const plan = validPlan();

    expect(() => verifyActualSegmentArtifactBudget({
      ...plan,
      requiredMaxBytes: BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
    }, [{ bytes: 10 }])).toThrow(
      'artifact plan requiredMaxBytes must match its budget mode',
    );

    expect(() => verifyActualSegmentArtifactBudget({
      ...plan,
      mode: 'absolute',
      requiredMaxBytes: BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
    }, [{ bytes: 10 }])).toThrow(
      'artifact plan requiredMaxBytes must match its budget mode',
    );

    expect(() => verifyActualSegmentArtifactBudget({
      ...plan,
      mode: 'degraded',
    }, [{ bytes: 10 }])).toThrow('unsupported artifact plan mode: degraded');
  });

  it('rejects a forged graph/external byte breakdown before report arithmetic', () => {
    const plan = validPlan();
    let reportReads = 0;
    const reports = [{
      get bytes() {
        reportReads += 1;
        return 10;
      },
    }];

    expect(() => verifyActualSegmentArtifactBudget({
      ...plan,
      graphDeclaredBytes: 7,
      externalDeclaredBytes: 4,
    }, reports)).toThrow(
      'artifact plan graph/external byte breakdown must equal declaredBytes',
    );

    expect(reportReads).toBe(0);
  });
});
