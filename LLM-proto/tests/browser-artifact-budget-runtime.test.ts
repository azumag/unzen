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
