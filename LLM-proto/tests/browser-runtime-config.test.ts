import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSER_ARTIFACT_BUDGET_MODE,
  DEFAULT_BROWSER_HEAD_SIZE,
  DEFAULT_BROWSER_KV_HEADS,
  DEFAULT_BROWSER_MODEL_ID,
  DEFAULT_BROWSER_SPLIT_ROOT,
  readBrowserRuntimeQueryConfig,
} from '../browser-harness/webgpu-2b-split/browser-runtime-config.js';
import { DEFAULT_BROWSER_CHECKPOINT_WAIT_MS } from '../browser-harness/webgpu-2b-split/checkpoint-wait-config.js';
import { DEFAULT_BROWSER_RUN_ID } from '../browser-harness/webgpu-2b-split/run-id.js';
import { DEFAULT_BROWSER_WORKER_ROLE } from '../browser-harness/webgpu-2b-split/runtime-validation.js';

describe('browser runtime query config', () => {
  it('preserves the established omitted-query defaults', () => {
    expect(readBrowserRuntimeQueryConfig(new URLSearchParams())).toEqual({
      role: DEFAULT_BROWSER_WORKER_ROLE,
      runId: DEFAULT_BROWSER_RUN_ID,
      explicitWorkerId: null,
      modelId: DEFAULT_BROWSER_MODEL_ID,
      splitRoot: DEFAULT_BROWSER_SPLIT_ROOT,
      kvHeads: DEFAULT_BROWSER_KV_HEADS,
      headSize: DEFAULT_BROWSER_HEAD_SIZE,
      artifactBudgetMode: DEFAULT_BROWSER_ARTIFACT_BUDGET_MODE,
      checkpointWaitMs: DEFAULT_BROWSER_CHECKPOINT_WAIT_MS,
    });

    expect(DEFAULT_BROWSER_MODEL_ID).toBe('onnx-community/Llama-3.2-1B-Instruct');
    expect(DEFAULT_BROWSER_SPLIT_ROOT).toBe('/models');
    expect(DEFAULT_BROWSER_KV_HEADS).toBe(8);
    expect(DEFAULT_BROWSER_HEAD_SIZE).toBe(64);
    expect(DEFAULT_BROWSER_ARTIFACT_BUDGET_MODE).toBe('absolute');
  });

  it('preserves explicit query values and numeric parsing semantics', () => {
    const params = new URLSearchParams({
      role: 'standby',
      run: 'run-42',
      worker: 'browser-B',
      model: 'custom/model',
      splitRoot: '/custom-models',
      kvHeads: '12',
      headSize: '80',
      artifactBudget: 'p0',
      checkpointWaitMs: '2500',
    });

    expect(readBrowserRuntimeQueryConfig(params)).toEqual({
      role: 'standby',
      runId: 'run-42',
      explicitWorkerId: 'browser-B',
      modelId: 'custom/model',
      splitRoot: '/custom-models',
      kvHeads: 12,
      headSize: 80,
      artifactBudgetMode: 'p0',
      checkpointWaitMs: 2500,
    });
  });

  it('does not hide malformed numeric query values from downstream validators', () => {
    const config = readBrowserRuntimeQueryConfig(new URLSearchParams({
      kvHeads: 'not-a-number',
      headSize: '',
      checkpointWaitMs: '-1',
    }));

    expect(Number.isNaN(config.kvHeads)).toBe(true);
    expect(config.headSize).toBe(0);
    expect(config.checkpointWaitMs).toBe(-1);
  });

  it('requires URLSearchParams-compatible input', () => {
    expect(() => readBrowserRuntimeQueryConfig(null)).toThrow(/URLSearchParams-compatible/);
    expect(() => readBrowserRuntimeQueryConfig({})).toThrow(/URLSearchParams-compatible/);
  });
});
