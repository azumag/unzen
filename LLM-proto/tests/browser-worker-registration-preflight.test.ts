import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSER_WORKER_ROLE,
  validateBrowserWorkerRegistrationConfig,
} from '../browser-harness/webgpu-2b-split/runtime-validation.js';

const bootstrap = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-bootstrap.js', import.meta.url),
  'utf8',
);
const runner = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-v3.js', import.meta.url),
  'utf8',
);

describe('browser worker registration preflight', () => {
  it('keeps the canonical browser worker default at segment0', () => {
    expect(DEFAULT_BROWSER_WORKER_ROLE).toBe('segment0');
  });

  it.each(['segment0', 'segment1', 'standby'])('accepts Coordinator role %s', (role) => {
    expect(validateBrowserWorkerRegistrationConfig({ role, workerId: 'browser-A_1.test' }))
      .toEqual({ role, workerId: 'browser-A_1.test' });
  });

  it('preserves omitted explicit worker IDs for runner-side generation', () => {
    expect(validateBrowserWorkerRegistrationConfig({ role: 'segment0', workerId: null }))
      .toEqual({ role: 'segment0', workerId: null });
    expect(validateBrowserWorkerRegistrationConfig({ role: 'segment0', workerId: undefined }))
      .toEqual({ role: 'segment0', workerId: undefined });
  });

  it('rejects roles outside the Coordinator allowlist without normalization', () => {
    for (const role of ['', ' segment0', 'segment0 ', 'SEGMENT0', 'other', null, 0]) {
      expect(() => validateBrowserWorkerRegistrationConfig({ role, workerId: null }))
        .toThrow(/browser worker role is invalid/);
    }
  });

  it('rejects invalid explicit worker IDs without trimming or coercion', () => {
    for (const workerId of [
      '',
      ' ',
      'browser a',
      'browser/a',
      'browser?a',
      'x'.repeat(129),
      42,
      true,
      [],
      {},
    ]) {
      expect(() => validateBrowserWorkerRegistrationConfig({ role: 'segment0', workerId }))
        .toThrow(/browser worker ID is invalid/);
    }
  });

  it('runs registration config validation before external runtime loading', () => {
    const configRead = bootstrap.indexOf('readBrowserRuntimeQueryConfig(params)');
    const registration = bootstrap.indexOf('validateBrowserWorkerRegistrationConfig({ role, workerId: explicitWorkerId })');
    const geometry = bootstrap.indexOf('validateBrowserKvGeometry({ kvHeads, headSize })');
    const ortLoad = bootstrap.indexOf('onnxruntime-web@1.22.0');
    const runnerImport = bootstrap.indexOf("import('./runner-v3.js')");

    expect(configRead).toBeGreaterThanOrEqual(0);
    expect(registration).toBeGreaterThan(configRead);
    expect(geometry).toBeGreaterThan(registration);
    expect(ortLoad).toBeGreaterThan(geometry);
    expect(runnerImport).toBeGreaterThan(ortLoad);
  });

  it('shares runtime query resolution between bootstrap and execution', () => {
    expect(bootstrap).toContain('readBrowserRuntimeQueryConfig(params)');
    expect(runner).toContain('readBrowserRuntimeQueryConfig(params)');
    expect(bootstrap).not.toContain("params.get('role')");
    expect(runner).not.toContain("params.get('role')");
    expect(bootstrap).not.toContain("params.get('model')");
    expect(runner).not.toContain("params.get('model')");
    expect(bootstrap).not.toContain("params.get('kvHeads')");
    expect(runner).not.toContain("params.get('kvHeads')");
    expect(bootstrap).not.toContain("params.get('artifactBudget')");
    expect(runner).not.toContain("params.get('artifactBudget')");
  });
});
