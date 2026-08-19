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
});
