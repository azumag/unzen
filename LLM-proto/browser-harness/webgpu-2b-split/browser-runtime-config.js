import { DEFAULT_BROWSER_CHECKPOINT_WAIT_MS } from './checkpoint-wait-config.js';
import { DEFAULT_BROWSER_RUN_ID } from './run-id.js';
import { DEFAULT_BROWSER_WORKER_ROLE } from './runtime-validation.js';

export const DEFAULT_BROWSER_MODEL_ID = 'onnx-community/Llama-3.2-1B-Instruct';
export const DEFAULT_BROWSER_SPLIT_ROOT = '/models';
export const DEFAULT_BROWSER_KV_HEADS = 8;
export const DEFAULT_BROWSER_HEAD_SIZE = 64;
export const DEFAULT_BROWSER_ARTIFACT_BUDGET_MODE = 'absolute';

export function readBrowserRuntimeQueryConfig(params) {
  if (!params || typeof params.get !== 'function') {
    throw new TypeError('browser runtime query config requires URLSearchParams-compatible input');
  }
  return {
    role: params.get('role') ?? DEFAULT_BROWSER_WORKER_ROLE,
    runId: params.get('run') ?? DEFAULT_BROWSER_RUN_ID,
    explicitWorkerId: params.get('worker'),
    modelId: params.get('model') ?? DEFAULT_BROWSER_MODEL_ID,
    splitRoot: params.get('splitRoot') ?? DEFAULT_BROWSER_SPLIT_ROOT,
    kvHeads: Number(params.get('kvHeads') ?? DEFAULT_BROWSER_KV_HEADS),
    headSize: Number(params.get('headSize') ?? DEFAULT_BROWSER_HEAD_SIZE),
    artifactBudgetMode: params.get('artifactBudget') ?? DEFAULT_BROWSER_ARTIFACT_BUDGET_MODE,
    checkpointWaitMs: Number(
      params.get('checkpointWaitMs') ?? DEFAULT_BROWSER_CHECKPOINT_WAIT_MS,
    ),
  };
}
