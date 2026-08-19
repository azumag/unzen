import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROVIDER_DOC = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.md';
const ROLLOUT_DOC = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md';
const PROVIDER_COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary';
const ROLLOUT_COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout';

describe('provider canary / terminal rollout docs alignment', () => {
  it('keeps README and PLAN v3.15 aligned with #149 and #152', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const [readme, plan] = await Promise.all([
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'PLAN.md'), 'utf8'),
    ]);

    for (const value of [PROVIDER_DOC, ROLLOUT_DOC, PROVIDER_COMMAND, ROLLOUT_COMMAND, '#149', '#152']) {
      expect(readme).toContain(value);
    }
    expect(readme).toContain('steady-state-enabled');
    expect(readme).toContain('bottlenecksToIssue: []');

    expect(plan).toContain('# unzen-LLM 計画書 v3.15');
    expect(plan).toContain('**ドキュメントバージョン**: 3.15');
    expect(plan).toContain(PROVIDER_DOC);
    expect(plan).toContain(ROLLOUT_DOC);
    expect(plan).toContain('#149');
    expect(plan).toContain('#152');
    expect(plan).toContain('steady-state-enabled');
    expect(plan).toContain('bottlenecksToIssue: []');
    expect(plan).toContain('validator chainの終端');
  });
});
