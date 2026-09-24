import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SMOLLM2_P0_CONTRACT,
  validateSmolLm2P0RuntimeParameters,
} from '../browser-harness/webgpu-2b-split/p0-manifest-contract.js';

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

describe('browser P0 runtime parameter preflight', () => {
  it('accepts only the pinned SmolLM2 P0 model geometry', () => {
    expect(validateSmolLm2P0RuntimeParameters({
      modelId: SMOLLM2_P0_CONTRACT.modelId,
      kvHeads: SMOLLM2_P0_CONTRACT.kvHeads,
      headSize: SMOLLM2_P0_CONTRACT.headSize,
    })).toMatchObject({
      status: 'pass',
      modelId: SMOLLM2_P0_CONTRACT.modelId,
    });

    expect(() => validateSmolLm2P0RuntimeParameters({
      modelId: 'onnx-community/Llama-3.2-1B-Instruct',
      kvHeads: SMOLLM2_P0_CONTRACT.kvHeads,
      headSize: SMOLLM2_P0_CONTRACT.headSize,
    })).toThrow(/runtime\.modelId mismatch/);
  });

  it('checks the pinned P0 contract before external runtime/module loading', () => {
    const configRead = bootstrap.indexOf('readBrowserRuntimeQueryConfig(params)');
    const modeGuard = bootstrap.indexOf("if (artifactBudgetMode === 'p0')");
    const validation = bootstrap.indexOf(
      'validateSmolLm2P0RuntimeParameters({ modelId, kvHeads, headSize });',
    );
    const ortLoad = bootstrap.indexOf('onnxruntime-web@1.22.0');
    const runnerImport = bootstrap.indexOf("import('./runner-v3.js')");

    expect(configRead).toBeGreaterThanOrEqual(0);
    expect(modeGuard).toBeGreaterThan(configRead);
    expect(validation).toBeGreaterThan(modeGuard);
    expect(ortLoad).toBeGreaterThan(validation);
    expect(runnerImport).toBeGreaterThan(ortLoad);
    expect(config).toContain(
      "modelId: params.get('model') ?? DEFAULT_BROWSER_MODEL_ID",
    );
  });

  it('keeps absolute mode outside the pinned P0 contract', () => {
    expect(bootstrap).toContain("if (artifactBudgetMode === 'p0')");
    expect(bootstrap).not.toContain("if (artifactBudgetMode === 'absolute')");
  });

  it('keeps the runner-side validation as defense in depth', () => {
    expect(runner).toContain("if (artifactBudgetMode === 'p0')");
    expect(runner).toContain(
      'validateSmolLm2P0RuntimeParameters({ modelId, kvHeads, headSize });',
    );
  });
});
