import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROVIDER_DOC = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.md';
const ROLLOUT_DOC = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md';
const PROVIDER_COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary';
const ROLLOUT_COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout';

describe('production provider canary / terminal rollout docs alignment', () => {
  it('keeps README, PLAN, package scripts and dedicated docs aligned', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const [readme, plan, packageJson, providerDoc, rolloutDoc] = await Promise.all([
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'PLAN.md'), 'utf8'),
      readFile(join(root, 'package.json'), 'utf8'),
      readFile(join(root, 'docs', PROVIDER_DOC), 'utf8'),
      readFile(join(root, 'docs', ROLLOUT_DOC), 'utf8'),
    ]);

    expect(readme).toContain(`docs/${PROVIDER_DOC}`);
    expect(readme).toContain(`docs/${ROLLOUT_DOC}`);
    expect(readme).toContain(PROVIDER_COMMAND);
    expect(readme).toContain(ROLLOUT_COMMAND);
    expect(readme).toContain('issues/149');
    expect(readme).toContain('issues/152');
    expect(readme).toContain('bottlenecksToIssue: []');
    expect(readme).toContain('operationalObligations');

    expect(plan).toContain('# unzen-LLM 計画書 v3.15');
    expect(plan).toContain('**ドキュメントバージョン**: 3.15');
    expect(plan).toContain(`docs/${PROVIDER_DOC}`);
    expect(plan).toContain(`docs/${ROLLOUT_DOC}`);
    expect(plan).toContain('#149');
    expect(plan).toContain('#152');
    expect(plan).toContain('steady-state-enabled');
    expect(plan).toContain('bottlenecksToIssue: []');
    expect(plan).toContain('operationalObligations');

    expect(packageJson).toContain(PROVIDER_COMMAND);
    expect(packageJson).toContain(ROLLOUT_COMMAND);
    expect(providerDoc).toContain('does **not** prove');
    expect(rolloutDoc).toContain('terminal');
    expect(rolloutDoc).toContain('bottlenecksToIssue: []');
  });
});
