import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSER_CHECKPOINT_WAIT_MS,
  validateBrowserCheckpointWaitConfig,
} from '../browser-harness/webgpu-2b-split/checkpoint-wait-config.js';

const config = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/browser-runtime-config.js', import.meta.url),
  'utf8',
);
const bootstrap = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-bootstrap.js', import.meta.url),
  'utf8',
);
const runner = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-v3.js', import.meta.url),
  'utf8',
);

describe('browser checkpoint wait preflight', () => {
  it('keeps the 120 second default', () => {
    expect(DEFAULT_BROWSER_CHECKPOINT_WAIT_MS).toBe(120_000);
    expect(validateBrowserCheckpointWaitConfig({
      role: 'segment1',
      checkpointWaitMs: DEFAULT_BROWSER_CHECKPOINT_WAIT_MS,
    })).toEqual({ role: 'segment1', checkpointWaitMs: 120_000 });
  });

  it('shares the canonical default between query resolution, bootstrap, and the full runner', () => {
    expect(config).toContain("import { DEFAULT_BROWSER_CHECKPOINT_WAIT_MS } from './checkpoint-wait-config.js';");
    expect(config).toContain("params.get('checkpointWaitMs') ?? DEFAULT_BROWSER_CHECKPOINT_WAIT_MS");
    expect(bootstrap).toContain('readBrowserRuntimeQueryConfig(params)');
    expect(runner).toContain('readBrowserRuntimeQueryConfig(params)');
    expect(bootstrap).not.toContain("params.get('checkpointWaitMs') ?? 120_000");
    expect(runner).not.toContain("params.get('checkpointWaitMs') ?? 120_000");
  });

  it('rejects non-positive and non-finite values for every browser role', () => {
    const invalidValues = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    for (const role of ['segment0', 'segment1', 'standby']) {
      for (const checkpointWaitMs of invalidValues) {
        expect(() => validateBrowserCheckpointWaitConfig({ role, checkpointWaitMs }))
          .toThrow(/checkpointWaitMs must be a positive number/);
      }
    }
  });

  it('requires checkpoint consumers to use positive safe integers', () => {
    for (const role of ['segment1', 'standby']) {
      expect(validateBrowserCheckpointWaitConfig({ role, checkpointWaitMs: 1 }))
        .toEqual({ role, checkpointWaitMs: 1 });
      expect(validateBrowserCheckpointWaitConfig({
        role,
        checkpointWaitMs: Number.MAX_SAFE_INTEGER,
      })).toEqual({ role, checkpointWaitMs: Number.MAX_SAFE_INTEGER });

      for (const checkpointWaitMs of [0.5, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => validateBrowserCheckpointWaitConfig({ role, checkpointWaitMs }))
          .toThrow(new RegExp(`positive safe integer for ${role}`));
      }
    }
  });

  it('preserves segment0 positive-finite compatibility because it never polls checkpoints', () => {
    expect(validateBrowserCheckpointWaitConfig({ role: 'segment0', checkpointWaitMs: 0.5 }))
      .toEqual({ role: 'segment0', checkpointWaitMs: 0.5 });
    expect(validateBrowserCheckpointWaitConfig({
      role: 'segment0',
      checkpointWaitMs: Number.MAX_SAFE_INTEGER + 1,
    })).toEqual({ role: 'segment0', checkpointWaitMs: Number.MAX_SAFE_INTEGER + 1 });
  });

  it('does not let an unknown role inherit segment0 compatibility', () => {
    expect(() => validateBrowserCheckpointWaitConfig({ role: 'other', checkpointWaitMs: 1000 }))
      .toThrow(/browser worker role is invalid/);
  });

  it('validates the timeout before ONNX Runtime or the full runner is loaded', () => {
    const configRead = bootstrap.indexOf('readBrowserRuntimeQueryConfig(params)');
    const validation = bootstrap.indexOf('validateBrowserCheckpointWaitConfig({ role, checkpointWaitMs })');
    const ortLoad = bootstrap.indexOf('onnxruntime-web@1.22.0');
    const runnerImport = bootstrap.indexOf("import('./runner-v3.js')");

    expect(configRead).toBeGreaterThanOrEqual(0);
    expect(validation).toBeGreaterThan(configRead);
    expect(ortLoad).toBeGreaterThan(validation);
    expect(runnerImport).toBeGreaterThan(ortLoad);
  });
});
