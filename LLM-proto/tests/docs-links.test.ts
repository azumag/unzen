import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('LLM prototype documentation links', () => {
  it('surfaces the 2B two-worker prototype from the LLM-proto entry points', () => {
    const prototypeSpec = readProjectFile('docs/2b-two-worker-prototype.md');
    const readme = readProjectFile('README.md');
    const plan = readProjectFile('PLAN.md');

    expect(prototypeSpec).toContain('2B-class model');
    expect(prototypeSpec).toContain('two-worker split path');
    expect(prototypeSpec).toContain('No browser worker opens a network connection outside');
    expect(readme).toContain('docs/2b-two-worker-prototype.md');
    expect(plan).toContain('./docs/2b-two-worker-prototype.md');
  });
});
