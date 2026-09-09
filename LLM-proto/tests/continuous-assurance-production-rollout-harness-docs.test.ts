import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOC = 'continuous-assurance-production-rollout-execution-harness.md';
const COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-rollout-harness';

describe('production rollout execution harness docs', () => {
  it('keeps the operational runbook, dedicated doc and package command aligned', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const [ops, doc, pkg] = await Promise.all([
      readFile(join(root, 'docs', 'continuous-assurance-production-ops-harness.md'), 'utf8'),
      readFile(join(root, 'docs', DOC), 'utf8'),
      readFile(join(root, 'package.json'), 'utf8'),
    ]);
    expect(ops).toContain(DOC);
    expect(ops).toContain('127.0.0.1:8792');
    expect(doc).toContain('steady-state-enabled');
    expect(doc).toContain('bottlenecksToIssue=[]');
    expect(doc).toContain('do **not** prove');
    expect(doc).toContain(COMMAND);
    expect(pkg).toContain(COMMAND);
  });

  it('keeps the known #190 empty-state bootstrap cycle explicit in both operator runbooks', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const [ops, doc] = await Promise.all([
      readFile(join(root, 'docs', 'continuous-assurance-production-ops-harness.md'), 'utf8'),
      readFile(join(root, 'docs', DOC), 'utf8'),
    ]);

    for (const runbook of [ops, doc]) {
      expect(runbook).toContain('#190');
      expect(runbook).toContain('currentRunId=null');
      expect(runbook).toContain('cold-start-bootstrap-cycle');
      expect(runbook).toContain('design-decision-required');
      expect(runbook).toContain('#145');
      expect(runbook).toContain('#149');
      expect(runbook).toContain('#152');
    }

    expect(ops).toContain('do not invoke #145 -> #149 -> #152 on a fresh/empty engine expecting it to converge');
    expect(doc).toContain('not a genesis/bootstrap procedure for an empty production engine');
    expect(doc).toContain('Do not fabricate fixture/self-reported #145/#149/#152 evidence');
  });
});
