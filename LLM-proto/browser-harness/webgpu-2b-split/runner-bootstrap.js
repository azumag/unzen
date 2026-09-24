import { validateBrowserArtifactBudgetMode } from './artifact-budget.js';
import {
  DEFAULT_BROWSER_CHECKPOINT_WAIT_MS,
  validateBrowserCheckpointWaitConfig,
} from './checkpoint-wait-config.js';
import {
  validateBrowserKvGeometry,
  validateBrowserWorkerRegistrationConfig,
} from './runtime-validation.js';

const params = new URLSearchParams(location.search);
const role = params.get('role') ?? 'segment0';
const explicitWorkerId = params.get('worker');
const kvHeads = Number(params.get('kvHeads') ?? 8);
const headSize = Number(params.get('headSize') ?? 64);
const artifactBudgetMode = params.get('artifactBudget') ?? 'absolute';
const checkpointWaitMs = Number(
  params.get('checkpointWaitMs') ?? DEFAULT_BROWSER_CHECKPOINT_WAIT_MS,
);

validateBrowserWorkerRegistrationConfig({ role, workerId: explicitWorkerId });
validateBrowserKvGeometry({ kvHeads, headSize });
validateBrowserArtifactBudgetMode(artifactBudgetMode);
validateBrowserCheckpointWaitConfig({ role, checkpointWaitMs });

await new Promise((resolve, reject) => {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.min.js';
  script.onload = resolve;
  script.onerror = () => reject(new Error('failed to load ONNX Runtime WebGPU runtime'));
  document.head.append(script);
});

await import('./runner-v3.js');
