import { describe, expect, it } from 'vitest';
import {
  BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
  BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
  planSegmentArtifactBudget,
  verifyActualSegmentArtifactBudget,
} from '../browser-harness/webgpu-2b-split/artifact-budget.js';
import {
  readResponseBytesBounded,
} from '../browser-harness/webgpu-2b-split/artifact-cache.js';

function segment(browserArtifactBytes: number, externalBytes = 1) {
  return {
    index: 0,
    browserArtifactBytes,
    externalData: [{ bytes: externalBytes }],
  };
}

function streamedResponse(chunks: number[][], headers?: HeadersInit) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  }), { headers });
}

describe('browser runtime artifact budget', () => {
  it('accepts exactly the P0 256 MiB limit and rejects one byte more before artifact load', () => {
    expect(planSegmentArtifactBudget(segment(BROWSER_SEGMENT_PREFERRED_MAX_BYTES), 'p0')).toMatchObject({
      declaredBytes: BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
      requiredMaxBytes: BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
      verdict: 'accepted',
    });
    expect(() => planSegmentArtifactBudget(
      segment(BROWSER_SEGMENT_PREFERRED_MAX_BYTES + 1),
      'p0',
    )).toThrow(/exceeds p0 browser artifact budget/);
  });

  it('rejects an absolute-limit overflow and inconsistent per-file declarations', () => {
    expect(() => planSegmentArtifactBudget(
      segment(BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES + 1),
      'absolute',
    )).toThrow(/absolute browser artifact limit/);
    expect(() => planSegmentArtifactBudget(segment(10, 10), 'absolute')).toThrow(
      /must exceed declared external-data bytes/,
    );
  });

  it('requires actual graph plus external bytes to equal the manifest total', () => {
    const plan = planSegmentArtifactBudget(segment(10, 4), 'p0');
    expect(verifyActualSegmentArtifactBudget(plan, [{ bytes: 6 }, { bytes: 4 }])).toMatchObject({
      actualBytes: 10,
      actualMatchesDeclared: true,
      verdict: 'accepted',
    });
    expect(() => verifyActualSegmentArtifactBudget(plan, [{ bytes: 6 }, { bytes: 5 }])).toThrow(
      /does not match manifest/,
    );
  });

  it('rejects coercible non-numeric JSON byte declarations', () => {
    expect(() => planSegmentArtifactBudget({
      index: 0,
      browserArtifactBytes: '10',
      externalData: [{ bytes: 4 }],
    }, 'p0')).toThrow(/browserArtifactBytes must be a non-negative safe integer/);

    expect(() => planSegmentArtifactBudget({
      index: 0,
      browserArtifactBytes: 10,
      externalData: [{ bytes: '4' }],
    }, 'p0')).toThrow(/externalData\[0\]\.bytes must be a non-negative safe integer/);

    const plan = planSegmentArtifactBudget(segment(10, 4), 'p0');
    expect(() => verifyActualSegmentArtifactBudget(plan, [{ bytes: 6 }, { bytes: '4' }])).toThrow(
      /artifact report\[1\]\.bytes must be a non-negative safe integer/,
    );
  });

  it('does not invoke hostile coercion hooks while reporting malformed budget input', () => {
    let coercions = 0;
    const hostile = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        throw new Error('artifact budget coercion must not run');
      },
      toString() {
        coercions += 1;
        throw new Error('artifact budget toString must not run');
      },
    };

    expect(() => planSegmentArtifactBudget({
      index: hostile,
      browserArtifactBytes: hostile,
      externalData: [{ bytes: 4 }],
    }, 'p0')).toThrow(/segment \[object\] browserArtifactBytes must be a non-negative safe integer: \[object\]/);

    expect(() => planSegmentArtifactBudget(segment(10, 4), hostile)).toThrow(
      /unsupported browser artifact budget mode: \[object\]/,
    );

    const plan = planSegmentArtifactBudget(segment(10, 4), 'p0');
    expect(() => verifyActualSegmentArtifactBudget(plan, [{ bytes: 6 }, { bytes: hostile }])).toThrow(
      /artifact report\[1\]\.bytes must be a non-negative safe integer: \[object\]/,
    );

    expect(coercions).toBe(0);
  });

  it.each([null, undefined, 'segment', 42, [], Symbol('segment')])(
    'rejects malformed segment top-level containers before field reads: %s',
    (input) => {
      expect(() => planSegmentArtifactBudget(input, 'p0')).toThrow(
        'segment artifact budget input must be an object',
      );
    },
  );

  it.each([null, undefined, 'reports', 42, {}, Symbol('reports')])(
    'rejects non-array artifact reports before reduce: %s',
    (reports) => {
      const plan = planSegmentArtifactBudget(segment(10, 4), 'p0');
      expect(() => verifyActualSegmentArtifactBudget(plan, reports)).toThrow(
        'artifact reports must be an array',
      );
    },
  );

  it('validates artifact plan byte fields and limit relationships before report arithmetic', () => {
    const plan = planSegmentArtifactBudget(segment(10, 4), 'p0');

    expect(() => verifyActualSegmentArtifactBudget(null, [])).toThrow(
      'artifact budget plan must be an object',
    );
    expect(() => verifyActualSegmentArtifactBudget({ ...plan, declaredBytes: '10' }, [])).toThrow(
      /artifact plan declaredBytes must be a non-negative safe integer/,
    );
    expect(() => verifyActualSegmentArtifactBudget({ ...plan, declaredBytes: 0 }, [])).toThrow(
      'artifact plan declaredBytes must be greater than zero',
    );
    expect(() => verifyActualSegmentArtifactBudget({ ...plan, requiredMaxBytes: 0 }, [])).toThrow(
      'artifact plan requiredMaxBytes must be greater than zero',
    );
    expect(() => verifyActualSegmentArtifactBudget({
      ...plan,
      requiredMaxBytes: BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES + 1,
    }, [])).toThrow('artifact plan requiredMaxBytes must not exceed absoluteMaxBytes');
    expect(() => verifyActualSegmentArtifactBudget({
      ...plan,
      declaredBytes: 11,
      requiredMaxBytes: 10,
      absoluteMaxBytes: 20,
    }, [])).toThrow('artifact plan declaredBytes must not exceed runtime limits');
  });
});

describe('bounded browser artifact stream reads', () => {
  it('accepts an exact-size response without Content-Length', async () => {
    const response = streamedResponse([[1, 2], [3, 4]]);
    const bytes = await readResponseBytesBounded(response, {
      maxBytes: 4,
      expectedBytes: 4,
      url: 'segment0.onnx',
    });
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  it('does not trust an understated Content-Length and aborts when the stream crosses the bound', async () => {
    const response = streamedResponse([[1, 2], [3, 4]], { 'content-length': '2' });
    await expect(readResponseBytesBounded(response, {
      maxBytes: 3,
      url: 'segment0.onnx_data',
    })).rejects.toThrow(/exceeds byte limit/);
  });

  it('rejects a declared oversize body before reading it and rejects short bodies', async () => {
    const oversized = streamedResponse([[1]], { 'content-length': '5' });
    await expect(readResponseBytesBounded(oversized, {
      maxBytes: 4,
      url: 'segment1.onnx_data',
    })).rejects.toThrow(/before body read/);

    const short = streamedResponse([[1, 2, 3]]);
    await expect(readResponseBytesBounded(short, {
      maxBytes: 4,
      expectedBytes: 4,
      url: 'segment1.onnx',
    })).rejects.toThrow(/byte size mismatch/);
  });
});
