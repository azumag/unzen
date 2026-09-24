import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateBrowserKvGeometry } from '../browser-harness/webgpu-2b-split/runtime-validation.js';

const config = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/browser-runtime-config.js', import.meta.url),
  'utf8',
);
const bootstrap = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-bootstrap.js', import.meta.url),
  'utf8',
);
const indexHtml = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/index.html', import.meta.url),
  'utf8',
);

describe('browser KV geometry preflight', () => {
  it('accepts positive safe-integer geometry without normalization', () => {
    expect(validateBrowserKvGeometry({ kvHeads: 1, headSize: 1 }))
      .toEqual({ kvHeads: 1, headSize: 1 });
    expect(validateBrowserKvGeometry({
      kvHeads: Number.MAX_SAFE_INTEGER,
      headSize: 64,
    })).toEqual({ kvHeads: Number.MAX_SAFE_INTEGER, headSize: 64 });
  });

  it('rejects invalid or coercible geometry synchronously', () => {
    const invalidValues = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '8',
      true,
      null,
    ];

    for (const invalid of invalidValues) {
      expect(() => validateBrowserKvGeometry({ kvHeads: invalid, headSize: 64 }))
        .toThrow(/kvHeads must be a positive safe integer/);
      expect(() => validateBrowserKvGeometry({ kvHeads: 8, headSize: invalid }))
        .toThrow(/headSize must be a positive safe integer/);
    }
  });

  it('validates query geometry before any external runtime or runner import', () => {
    const configRead = bootstrap.indexOf('readBrowserRuntimeQueryConfig(params)');
    const validation = bootstrap.indexOf('validateBrowserKvGeometry({ kvHeads, headSize })');
    const ortLoad = bootstrap.indexOf('onnxruntime-web@1.22.0');
    const runnerImport = bootstrap.indexOf("import('./runner-v3.js')");

    expect(configRead).toBeGreaterThanOrEqual(0);
    expect(validation).toBeGreaterThan(configRead);
    expect(ortLoad).toBeGreaterThan(validation);
    expect(runnerImport).toBeGreaterThan(ortLoad);
    expect(config).toContain("kvHeads: Number(params.get('kvHeads') ?? DEFAULT_BROWSER_KV_HEADS)");
    expect(config).toContain("headSize: Number(params.get('headSize') ?? DEFAULT_BROWSER_HEAD_SIZE)");
  });

  it('routes the harness through the preflight bootstrap only', () => {
    expect(indexHtml).toContain('<script type="module" src="./runner-bootstrap.js"></script>');
    expect(indexHtml).not.toContain('onnxruntime-web@1.22.0');
    expect(indexHtml).not.toContain('src="./runner-v3.js"');
  });
});
