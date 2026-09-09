import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COLD_START_PREFLIGHT_EXIT = Object.freeze({
  ready: 0,
  invalid: 1,
  hold: 2,
  usage: 64,
});

function finiteTimestampOrNull(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function normalizedRunId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

export function classifyContinuousAssuranceEngineState(state) {
  const base = {
    schemaVersion: '1.0.0',
    kind: 'unzen-continuous-assurance-cold-start-preflight',
  };

  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {
      ...base,
      status: 'invalid',
      decision: 'repair-engine-state-before-canary',
      reason: 'engine-state-object-required',
    };
  }

  const currentRunId = normalizedRunId(state.currentRunId);
  const snapshotUpdatedAtMs = finiteTimestampOrNull(state.snapshotUpdatedAtMs);
  const nextDueAtMs = finiteTimestampOrNull(state.nextDueAtMs);
  const normalized = {
    scope: typeof state.scope === 'string' && state.scope.length > 0 ? state.scope : null,
    currentRunId: currentRunId === undefined ? null : currentRunId,
    snapshotUpdatedAtMs: snapshotUpdatedAtMs === undefined ? null : snapshotUpdatedAtMs,
    nextDueAtMs: nextDueAtMs === undefined ? null : nextDueAtMs,
  };

  if (currentRunId === undefined || snapshotUpdatedAtMs === undefined || nextDueAtMs === undefined) {
    return {
      ...base,
      status: 'invalid',
      decision: 'repair-engine-state-before-canary',
      reason: 'engine-state-field-invalid',
      engineState: normalized,
    };
  }

  if (snapshotUpdatedAtMs !== null && nextDueAtMs !== null) {
    return {
      ...base,
      status: 'pass',
      decision: 'continue-deployment-canary',
      engineState: normalized,
    };
  }

  if (currentRunId === null && snapshotUpdatedAtMs === null && nextDueAtMs === null) {
    return {
      ...base,
      status: 'hold',
      decision: 'design-decision-required',
      engineState: normalized,
      blocker: {
        issue: 190,
        kind: 'cold-start-bootstrap-cycle',
        requiredState: 'engine snapshot with finite snapshotUpdatedAtMs and nextDueAtMs',
      },
    };
  }

  return {
    ...base,
    status: 'invalid',
    decision: 'repair-engine-state-before-canary',
    reason: 'engine-snapshot-incomplete',
    engineState: normalized,
  };
}

async function readStdin() {
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

async function readStateSource(source) {
  return source === '-' ? readStdin() : readFile(source, 'utf8');
}

export async function runContinuousAssuranceColdStartPreflight(source) {
  let parsed;
  try {
    parsed = JSON.parse(await readStateSource(source));
  } catch (error) {
    return {
      result: {
        schemaVersion: '1.0.0',
        kind: 'unzen-continuous-assurance-cold-start-preflight',
        status: 'invalid',
        decision: 'repair-engine-state-before-canary',
        reason: 'engine-state-json-invalid',
        detail: error instanceof Error ? error.message : String(error),
      },
      exitCode: COLD_START_PREFLIGHT_EXIT.invalid,
    };
  }

  const result = classifyContinuousAssuranceEngineState(parsed);
  return {
    result,
    exitCode: result.status === 'pass'
      ? COLD_START_PREFLIGHT_EXIT.ready
      : result.status === 'hold'
        ? COLD_START_PREFLIGHT_EXIT.hold
        : COLD_START_PREFLIGHT_EXIT.invalid,
  };
}

async function main() {
  const source = process.argv[2];
  if (!source || process.argv.length > 3) {
    console.error('usage: node tools/continuous-assurance-cold-start-preflight.mjs <engine-state.json|->');
    process.exitCode = COLD_START_PREFLIGHT_EXIT.usage;
    return;
  }

  const { result, exitCode } = await runContinuousAssuranceColdStartPreflight(source);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = exitCode;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}
