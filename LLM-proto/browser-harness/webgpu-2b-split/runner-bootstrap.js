import { validateBrowserArtifactBudgetMode } from './artifact-budget.js';
import { readBrowserRuntimeQueryConfig } from './browser-runtime-config.js';
import { validateBrowserCheckpointWaitConfig } from './checkpoint-wait-config.js';
import { validateSmolLm2P0RuntimeParameters } from './p0-manifest-contract.js';
import { validateBrowserRunId } from './run-id.js';
import {
  validateBrowserKvGeometry,
  validateBrowserWorkerRegistrationConfig,
} from './runtime-validation.js';

const params = new URLSearchParams(location.search);
const {
  role,
  runId,
  explicitWorkerId,
  modelId,
  kvHeads,
  headSize,
  artifactBudgetMode,
  checkpointWaitMs,
} = readBrowserRuntimeQueryConfig(params);

validateBrowserWorkerRegistrationConfig({ role, workerId: explicitWorkerId });
validateBrowserRunId(runId);
validateBrowserKvGeometry({ kvHeads, headSize });
validateBrowserArtifactBudgetMode(artifactBudgetMode);
validateBrowserCheckpointWaitConfig({ role, checkpointWaitMs });
if (artifactBudgetMode === 'p0') {
  validateSmolLm2P0RuntimeParameters({ modelId, kvHeads, headSize });
}

await new Promise((resolve, reject) => {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.min.js';
  script.onload = resolve;
  script.onerror = () => reject(new Error('failed to load ONNX Runtime WebGPU runtime'));
  document.head.append(script);
});

await import('./runner-v3.js');
