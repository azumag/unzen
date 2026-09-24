import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveCoordinatorReceiptExpectedRunId } from '../browser-harness/webgpu-2b-split/coordinator-receipt-run-binding.js';
import {
  BROWSER_RUN_ID_PATTERN,
  DEFAULT_BROWSER_RUN_ID,
  validateBrowserRunId,
} from '../browser-harness/webgpu-2b-split/run-id.js';

const bootstrap = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-bootstrap.js', import.meta.url),
  'utf8',
);
const indexHtml = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/index.html', import.meta.url),
  'utf8',
);
const coordinator = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/serve.mjs', import.meta.url),
  'utf8',
);
const receiptBinding = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/coordinator-receipt-run-binding.js', import.meta.url),
  'utf8',
);

describe('browser run ID preflight', () => {
  it('accepts the Coordinator execution-namespace syntax without normalization', () => {
    for (const runId of ['a', 'demo', 'run-1', 'run_1', 'run.1', 'A0._-', 'x'.repeat(128)]) {
      expect(validateBrowserRunId(runId)).toBe(runId);
      expect(BROWSER_RUN_ID_PATTERN.test(runId)).toBe(true);
    }
  });

  it('rejects empty, path-like, whitespace, overlong, and coercible IDs', () => {
    const invalid = [
      '',
      ' ',
      ' run',
      'run ',
      'a/b',
      '../run',
      'a%2Fb',
      'x'.repeat(129),
      null,
      undefined,
      1,
      true,
      ['run'],
    ];

    for (const runId of invalid) {
      expect(() => validateBrowserRunId(runId)).toThrow(/browser run ID is invalid/);
    }
  });

  it('matches the Coordinator safeRunId syntax exactly', () => {
    expect(BROWSER_RUN_ID_PATTERN.source).toBe('^[A-Za-z0-9._-]{1,128}$');
    expect(coordinator).toContain("if (!/^[A-Za-z0-9._-]{1,128}$/.test(raw)) throw new Error('invalid run id');");
  });

  it('shares the canonical browser syntax and default with Coordinator receipt binding', () => {
    expect(DEFAULT_BROWSER_RUN_ID).toBe('demo');
    expect(resolveCoordinatorReceiptExpectedRunId(undefined, '?run=receipt-1')).toBe('receipt-1');
    expect(resolveCoordinatorReceiptExpectedRunId(undefined, '')).toBe(DEFAULT_BROWSER_RUN_ID);
    expect(() => resolveCoordinatorReceiptExpectedRunId(undefined, '?run=bad%2Fid'))
      .toThrow('Coordinator receipt expected run ID is invalid');

    expect(bootstrap).toContain("import { DEFAULT_BROWSER_RUN_ID, validateBrowserRunId } from './run-id.js';");
    expect(bootstrap).toContain("params.get('run') ?? DEFAULT_BROWSER_RUN_ID");
    expect(bootstrap).not.toContain("params.get('run') ?? 'demo'");

    expect(receiptBinding).toContain("import { BROWSER_RUN_ID_PATTERN, DEFAULT_BROWSER_RUN_ID } from './run-id.js';");
    expect(receiptBinding).toContain("params.get('run') ?? DEFAULT_BROWSER_RUN_ID");
    expect(receiptBinding).not.toContain("params.get('run') ?? 'demo'");
    expect(receiptBinding).not.toContain('const SAFE_RUN_ID =');
    expect(receiptBinding).not.toContain('/^[A-Za-z0-9._-]{1,128}$/');
  });

  it('validates run IDs before ONNX Runtime or the full runner is loaded', () => {
    const parse = bootstrap.indexOf("params.get('run') ?? DEFAULT_BROWSER_RUN_ID");
    const validation = bootstrap.indexOf('validateBrowserRunId(runId)');
    const ortLoad = bootstrap.indexOf('onnxruntime-web@1.22.0');
    const runnerImport = bootstrap.indexOf("import('./runner-v3.js')");

    expect(parse).toBeGreaterThanOrEqual(0);
    expect(validation).toBeGreaterThan(parse);
    expect(ortLoad).toBeGreaterThan(validation);
    expect(runnerImport).toBeGreaterThan(ortLoad);
  });

  it('keeps the HTML entrypoint on the preflight bootstrap', () => {
    expect(indexHtml).toContain('<script type="module" src="./runner-bootstrap.js"></script>');
    expect(indexHtml).not.toContain('src="./runner-v3.js"');
  });
});
