import { validateBrowserWorkerRegistrationConfig } from './runtime-validation.js';

export const DEFAULT_BROWSER_CHECKPOINT_WAIT_MS = 120_000;

const CHECKPOINT_CONSUMER_ROLES = new Set(['segment1', 'standby']);

/**
 * Validate the browser harness checkpoint wait configuration before any runtime
 * or network side effect. Segment 0 never consumes the wait budget, so retain
 * its historical positive-finite compatibility. Roles that poll checkpoints
 * must satisfy waitForCheckpointBounded()'s positive-safe-integer domain.
 */
export function validateBrowserCheckpointWaitConfig({ role, checkpointWaitMs }) {
  // Reuse the browser role contract so an unknown role cannot accidentally be
  // treated like the non-consuming segment0 path by this standalone helper.
  validateBrowserWorkerRegistrationConfig({ role, workerId: undefined });

  if (
    typeof checkpointWaitMs !== 'number'
    || !Number.isFinite(checkpointWaitMs)
    || checkpointWaitMs <= 0
  ) {
    throw new Error(`checkpointWaitMs must be a positive number: ${String(checkpointWaitMs)}`);
  }

  if (CHECKPOINT_CONSUMER_ROLES.has(role) && !Number.isSafeInteger(checkpointWaitMs)) {
    throw new Error(
      `checkpointWaitMs must be a positive safe integer for ${role}: ${String(checkpointWaitMs)}`,
    );
  }

  return { role, checkpointWaitMs };
}
