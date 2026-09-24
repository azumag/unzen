import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateBrowserArtifactBudgetMode } from '../browser-harness/webgpu-2b-split/artifact-budget.js';

const bootstrap = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-bootstrap.js', import.meta.url),
  'utf8',
);

describe('browser artifact budget mode preflight', () => {
  it.each(['absolute', 'p0'])('accepts supported mode %s exactly', (mode) => {
    expect(validateBrowserArtifactBudgetMode(mode)).toBe(mode);
  });

  it('rejects unsupported modes without normalization', () => {
    for (const mode of ['', ' ', ' absolute', 'absolute ', 'ABSOLUTE', 'P0', 'other', null, 0, true]) {
      expect(() => validateBrowserArtifactBudgetMode(mode))
        .toThrow(/unsupported browser artifact budget mode/);
    }
  });

  it('runs artifact budget validation before external runtime loading', () => {
    const registration = bootstrap.indexOf('validateBrowserWorkerRegistrationConfig({ role, workerId: explicitWorkerId })');
    const geometry = bootstrap.indexOf('validateBrowserKvGeometry({ kvHeads, headSize })');
    const budget = bootstrap.indexOf('validateBrowserArtifactBudgetMode(artifactBudgetMode)');
    const ortLoad = bootstrap.indexOf('onnxruntime-web@1.22.0');
    const runnerImport = bootstrap.indexOf("import('./runner-v3.js')");

    expect(registration).toBeGreaterThanOrEqual(0);
    expect(geometry).toBeGreaterThan(registration);
    expect(budget).toBeGreaterThan(geometry);
    expect(ortLoad).toBeGreaterThan(budget);
    expect(runnerImport).toBeGreaterThan(ortLoad);
    expect(bootstrap).toContain("params.get('artifactBudget') ?? 'absolute'");
  });
});
