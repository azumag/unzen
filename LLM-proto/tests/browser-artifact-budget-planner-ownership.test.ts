import { describe, expect, it } from 'vitest';
import {
  planSegmentArtifactBudget,
} from '../browser-harness/webgpu-2b-split/artifact-budget.js';

describe('browser artifact budget planner ownership', () => {
  it('detaches external-data membership before reading bytes', () => {
    const reads = [0, 0];
    const originalSecond = {
      get bytes() {
        reads[1] += 1;
        return reads[1] === 1 ? 4 : 400;
      },
    };
    const externalData: Array<{ bytes: number }> = [
      {
        get bytes() {
          reads[0] += 1;
          externalData[1] = { bytes: 400 };
          return reads[0] === 1 ? 4 : 400;
        },
      },
      originalSecond,
    ];

    const result = planSegmentArtifactBudget({
      index: 7,
      browserArtifactBytes: 10,
      externalData,
    }, 'p0');

    expect(result).toMatchObject({
      declaredBytes: 10,
      externalDeclaredBytes: 8,
      graphDeclaredBytes: 2,
      verdict: 'accepted',
    });
    expect(reads).toEqual([1, 1]);
    expect(externalData[1]).toEqual({ bytes: 400 });
  });

  it('reads planner contract fields once and ignores unrelated accessors', () => {
    const reads = {
      index: 0,
      browserArtifactBytes: 0,
      externalData: 0,
      unrelated: 0,
    };
    const input = {
      get index() {
        reads.index += 1;
        return reads.index === 1 ? 3 : 99;
      },
      get browserArtifactBytes() {
        reads.browserArtifactBytes += 1;
        return reads.browserArtifactBytes === 1 ? 10 : 999;
      },
      get externalData() {
        reads.externalData += 1;
        return reads.externalData === 1 ? [{ bytes: 4 }] : [{ bytes: 999 }];
      },
      get unrelated() {
        reads.unrelated += 1;
        throw new Error('unrelated accessor must not run');
      },
    };

    expect(planSegmentArtifactBudget(input, 'p0')).toMatchObject({
      declaredBytes: 10,
      externalDeclaredBytes: 4,
      graphDeclaredBytes: 6,
      verdict: 'accepted',
    });
    expect(reads).toEqual({
      index: 1,
      browserArtifactBytes: 1,
      externalData: 1,
      unrelated: 0,
    });
  });
});
