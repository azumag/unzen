import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runner = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-v3.js', import.meta.url),
  'utf8',
);

const html = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/p0-smollm2.html', import.meta.url),
  'utf8',
);

describe('SmolLM2 browser P0 redirect contract', () => {
  it('pins evidence-defining model geometry and artifact budget against query overrides', () => {
    expect(html).toContain("params.set('model', 'onnx-community/SmolLM2-135M-ONNX');");
    expect(html).toContain("params.set('kvHeads', '3');");
    expect(html).toContain("params.set('headSize', '64');");
    expect(html).toContain("params.set('artifactBudget', 'p0');");

    for (const parameter of ['model', 'kvHeads', 'headSize', 'artifactBudget']) {
      expect(html).not.toContain(`if (!params.has('${parameter}'))`);
    }
  });

  it('pins the tokenizer to the same repository revision in P0 mode', () => {
    expect(runner).toContain("revision: SMOLLM2_P0_CONTRACT.modelRevision");
    expect(runner).toContain("artifactBudgetMode === 'p0'");
    expect(runner).toContain('const tokenizer = await loadTokenizer();');
  });

  it('keeps operator-specific run and worker-role parameters configurable', () => {
    expect(html).toContain("if (!params.has('role')) params.set('role', 'segment0');");
    expect(html).toContain("if (!params.has('run')) params.set('run', 'smollm2-p0');");
  });
});
