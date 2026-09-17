import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  planSegmentArtifactBudget,
} from '../browser-harness/webgpu-2b-split/artifact-budget.js';

const GRAPH_SHA = 'A'.repeat(64);
const EXTERNAL_SHA = 'B'.repeat(64);

function changingField<T>(first: T, later: T, reads: Record<string, number>, key: string) {
  return {
    enumerable: true,
    get() {
      reads[key] = (reads[key] ?? 0) + 1;
      return reads[key] === 1 ? first : later;
    },
  };
}

describe('browser artifact load snapshot', () => {
  it('owns every loader field once and freezes canonical load identity', () => {
    const reads: Record<string, number> = {};
    const externalEntry = {};
    Object.defineProperties(externalEntry, {
      bytes: changingField(4, 400, reads, 'externalBytes'),
      location: changingField('weights/segment0.bin', '../outside.bin', reads, 'externalLocation'),
      sha256: changingField(EXTERNAL_SHA, 'malicious', reads, 'externalSha256'),
    });

    const segment = { index: 0, browserArtifactBytes: 10, externalData: [externalEntry] };
    Object.defineProperties(segment, {
      path: changingField('segment0.onnx', '../outside.onnx', reads, 'path'),
      sha256: changingField(GRAPH_SHA, 'malicious', reads, 'sha256'),
    });

    const plan = planSegmentArtifactBudget(segment, 'p0');

    expect(plan.artifactLoad).toEqual({
      graph: {
        path: 'segment0.onnx',
        sha256: GRAPH_SHA.toLowerCase(),
        bytes: 6,
      },
      externalData: [{
        location: 'weights/segment0.bin',
        sha256: EXTERNAL_SHA.toLowerCase(),
        bytes: 4,
      }],
    });
    expect(Object.isFrozen(plan.artifactLoad)).toBe(true);
    expect(Object.isFrozen(plan.artifactLoad?.graph)).toBe(true);
    expect(Object.isFrozen(plan.artifactLoad?.externalData)).toBe(true);
    expect(Object.isFrozen(plan.artifactLoad?.externalData[0])).toBe(true);
    expect(reads).toEqual({
      externalBytes: 1,
      externalLocation: 1,
      externalSha256: 1,
      path: 1,
      sha256: 1,
    });

    // A second caller-owned read now produces unsafe values, proving the owned
    // snapshot is detached from the original accessor-backed manifest entry.
    expect((segment as { path: string }).path).toBe('../outside.onnx');
    expect((segment as { sha256: string }).sha256).toBe('malicious');
    expect((externalEntry as { location: string }).location).toBe('../outside.bin');
    expect((externalEntry as { sha256: string }).sha256).toBe('malicious');
    expect((externalEntry as { bytes: number }).bytes).toBe(400);
    expect(plan.artifactLoad?.graph.path).toBe('segment0.onnx');
    expect(plan.artifactLoad?.externalData[0].location).toBe('weights/segment0.bin');
  });

  it('requires complete digest-backed load identity when runtime locators are present', () => {
    expect(() => planSegmentArtifactBudget({
      index: 0,
      browserArtifactBytes: 10,
      path: 'segment0.onnx',
      externalData: [{ bytes: 4, location: 'weights.bin', sha256: EXTERNAL_SHA }],
    }, 'p0')).toThrow(/segment 0 sha256 must be a 64-character hexadecimal SHA-256/);

    expect(() => planSegmentArtifactBudget({
      index: 0,
      browserArtifactBytes: 10,
      path: 'segment0.onnx',
      sha256: GRAPH_SHA,
      externalData: [{ bytes: 4, location: 'weights.bin', sha256: 'not-a-digest' }],
    }, 'p0')).toThrow(/externalData\[0\]\.sha256 must be a 64-character hexadecimal SHA-256/);
  });

  it('keeps createWebGpuSession on the planner-owned snapshot after preflight', () => {
    const runner = readFileSync(
      new URL('../browser-harness/webgpu-2b-split/runner-v3.js', import.meta.url),
      'utf8',
    );
    const match = runner.match(
      /async function createWebGpuSession\(segment, manifest, signal\) \{([\s\S]*?)\n\}\n\nasync function runSegment0/,
    );
    expect(match).not.toBeNull();
    const body = match?.[1] ?? '';

    expect(body).toContain('const artifactLoad = budgetPlan.artifactLoad;');
    expect(body).toContain('for (const entry of artifactLoad.externalData)');
    expect(body).not.toMatch(/segment\.(?:path|sha256|externalData)/);
    expect(body).not.toContain('Number(entry.bytes)');
  });
});
