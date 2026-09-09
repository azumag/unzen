import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COLD_START_PREFLIGHT_EXIT,
  classifyContinuousAssuranceEngineState,
} from '../tools/continuous-assurance-cold-start-preflight.mjs';

const SCRIPT = fileURLToPath(new URL('../tools/continuous-assurance-cold-start-preflight.mjs', import.meta.url));

function readyState() {
  return {
    scope: 'publisher-tax-exception-archive-dr',
    currentRunId: 'steady-state-current',
    snapshotUpdatedAtMs: 1_000,
    nextDueAtMs: 2_000,
  };
}

describe('continuous assurance cold-start preflight', () => {
  it('passes only when both snapshot timestamps are finite safe integers', () => {
    expect(classifyContinuousAssuranceEngineState(readyState())).toMatchObject({
      status: 'pass',
      decision: 'continue-deployment-canary',
      engineState: readyState(),
    });
  });

  it('reports the known #190 cold-start bootstrap cycle without choosing a bootstrap design', () => {
    expect(classifyContinuousAssuranceEngineState({
      scope: 'publisher-tax-exception-archive-dr',
      currentRunId: null,
      snapshotUpdatedAtMs: null,
      nextDueAtMs: null,
    })).toEqual({
      schemaVersion: '1.0.0',
      kind: 'unzen-continuous-assurance-cold-start-preflight',
      status: 'hold',
      decision: 'design-decision-required',
      engineState: {
        scope: 'publisher-tax-exception-archive-dr',
        currentRunId: null,
        snapshotUpdatedAtMs: null,
        nextDueAtMs: null,
      },
      blocker: {
        issue: 190,
        kind: 'cold-start-bootstrap-cycle',
        requiredState: 'engine snapshot with finite snapshotUpdatedAtMs and nextDueAtMs',
      },
    });
  });

  it('does not misclassify a partially initialized snapshot as the known cold-start cycle', () => {
    expect(classifyContinuousAssuranceEngineState({
      scope: 'publisher-tax-exception-archive-dr',
      currentRunId: 'steady-state-current',
      snapshotUpdatedAtMs: 1_000,
      nextDueAtMs: null,
    })).toMatchObject({
      status: 'invalid',
      decision: 'repair-engine-state-before-canary',
      reason: 'engine-snapshot-incomplete',
    });
  });

  it.each([
    {},
    { currentRunId: null, snapshotUpdatedAtMs: null, nextDueAtMs: null },
    { ...readyState(), scope: '' },
    { ...readyState(), currentRunId: undefined },
    { ...readyState(), currentRunId: '' },
    { ...readyState(), snapshotUpdatedAtMs: undefined },
    { ...readyState(), snapshotUpdatedAtMs: '1000' },
    { ...readyState(), nextDueAtMs: undefined },
    { ...readyState(), nextDueAtMs: -1 },
    { ...readyState(), nextDueAtMs: 1.5 },
  ])('fails closed on missing or malformed state fields: %j', (state) => {
    expect(classifyContinuousAssuranceEngineState(state)).toMatchObject({
      status: 'invalid',
      decision: 'repair-engine-state-before-canary',
      reason: 'engine-state-field-invalid',
    });
  });

  it('uses a distinct non-zero exit code for the design-decision HOLD path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unzen-cold-start-preflight-'));
    const statePath = join(dir, 'state.json');
    try {
      await writeFile(statePath, JSON.stringify({
        scope: 'publisher-tax-exception-archive-dr',
        currentRunId: null,
        snapshotUpdatedAtMs: null,
        nextDueAtMs: null,
      }));
      const result = spawnSync(process.execPath, [SCRIPT, statePath], { encoding: 'utf8' });
      expect(result.status).toBe(COLD_START_PREFLIGHT_EXIT.hold);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'hold',
        blocker: { issue: 190, kind: 'cold-start-bootstrap-cycle' },
      });
      expect(result.stderr).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns success from the CLI for a ready state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unzen-cold-start-preflight-'));
    const statePath = join(dir, 'state.json');
    try {
      await writeFile(statePath, JSON.stringify(readyState()));
      const result = spawnSync(process.execPath, [SCRIPT, statePath], { encoding: 'utf8' });
      expect(result.status).toBe(COLD_START_PREFLIGHT_EXIT.ready);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'pass' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
