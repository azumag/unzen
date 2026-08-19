import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROVIDER_DOC = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.md';
const ROLLOUT_DOC = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md';
const PROVIDER_COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary';
const ROLLOUT_COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout';

describe('final continuous-assurance README / PLAN alignment', () => {
  it('keeps #149 and terminal #152 aligned in README and PLAN v3.15', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const [readme, plan] = await Promise.all([
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'PLAN.md'), 'utf8'),
    ]);

    for (const doc of [PROVIDER_DOC, ROLLOUT_DOC]) {
      expect(readme).toContain(`docs/${doc}`);
      expect(plan).toContain(`docs/${doc}`);
    }
    for (const command of [PROVIDER_COMMAND, ROLLOUT_COMMAND]) {
      expect(readme).toContain(command);
    }

    expect(readme).toContain('[#149]');
    expect(readme).toContain('[#152]');
    expect(readme).toContain('`steady-state-enabled` + `bottlenecksToIssue: []`');
    expect(readme).toContain('`operationalObligations`');

    expect(plan).toContain('# unzen-LLM 計画書 v3.15');
    expect(plan).toContain('42. [Publisher tax filing production exception archive DR provider continuous assurance production provider canary (#149)]');
    expect(plan).toContain('43. [Publisher tax filing production exception archive DR provider continuous assurance production operations rollout terminal gate (#152)]');
    expect(plan).toContain('clean completionは`steady-state-enabled`、`bottlenecksToIssue: []`');
    expect(plan).toContain('**ドキュメントバージョン**: 3.15');
    expect(plan).toContain('- v3.15: #152 production operations rollout terminal gate');
    expect(plan).toContain('- v3.14: #149 production provider canary');
  });
});
