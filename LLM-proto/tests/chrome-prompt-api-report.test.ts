import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateChromePromptApiFeasibilityDecision,
  validateChromePromptApiFeasibilityReport,
} from '../src/chrome-prompt-api-report.js';
import { validateEvidenceEnvelope } from '../src/evidence.js';
import {
  createChromePromptApiCapturedEnvelope,
  createChromePromptApiReport,
  createChromePromptApiReportWithEnvelope,
  createChromePromptApiSelfReportedEnvelope,
  createChromePromptApiSyntheticEnvelope,
  createScenarioRecords,
} from './chrome-prompt-api-fixtures.js';
import { createVerifiedValidationOptions } from './evidence-envelope-helpers.js';

describe('ChromePromptApiFeasibilityReport schema validation', () => {
  it('accepts a self-reported harness report and labels it self-reported, not real-browser-verified', async () => {
    const result = await validateChromePromptApiFeasibilityReport(
      createChromePromptApiReport(),
    );

    expect(result.status).toBe('valid');
    expect(result.readiness).toBe('self-reported');
    expect(result.readiness).not.toBe('real-browser-verified');
    expect(result.issues).toEqual([]);
  });

  it('rejects a report without a runId', async () => {
    const result = await validateChromePromptApiFeasibilityReport(
      createChromePromptApiReport({ runId: '' }),
    );

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'missing-run-id', path: '$.runId' }),
    );
  });

  it('rejects an unsupported report schema version', async () => {
    const result = await validateChromePromptApiFeasibilityReport(
      createChromePromptApiReport({ schemaVersion: '9.9.9' }),
    );

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'unsupported-schema-version' }),
    );
  });

  it('rejects an unknown scenario discriminator', async () => {
    const report = createChromePromptApiReport();
    const result = await validateChromePromptApiFeasibilityReport({
      ...report,
      scenarios: [{ scenario: 'not-a-scenario', scenarioStatus: 'pass' }],
    });

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-scenario' }),
    );
  });

  it('rejects an invalid final availability state', async () => {
    const report = createChromePromptApiReport();
    const result = await validateChromePromptApiFeasibilityReport({
      ...report,
      scenarios: report.scenarios.map((record) => (
        record.scenario === 'availability-state-transitions'
          ? { ...record, finalAvailabilityState: 'magic-state' }
          : record
      )),
    });

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-enum-field' }),
    );
  });

  it('rejects an invalid scenarioStatus', async () => {
    const report = createChromePromptApiReport();
    const result = await validateChromePromptApiFeasibilityReport({
      ...report,
      scenarios: report.scenarios.map((record) => (
        record.scenario === 'abort-interruption'
          ? { ...record, scenarioStatus: 'maybe' }
          : record
      )),
    });

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-scenario-status' }),
    );
  });

  it('rejects an empty scenarios array', async () => {
    const result = await validateChromePromptApiFeasibilityReport(
      createChromePromptApiReport({ scenarios: [] }),
    );

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-scenarios' }),
    );
  });

  it('rejects a malformed surface matrix entry', async () => {
    const report = createChromePromptApiReport();
    const result = await validateChromePromptApiFeasibilityReport({
      ...report,
      scenarios: report.scenarios.map((record) => (
        record.scenario === 'surface-matrix'
          ? {
              ...record,
              surfaces: [{ surface: 'not-a-surface', tested: true }],
            }
          : record
      )),
    });

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-enum-field' }),
    );
  });
});

describe('ChromePromptApiFeasibilityReport provenance separation', () => {
  it('labels a report carrying a synthetic envelope as synthetic', async () => {
    const report = createChromePromptApiReport();
    const result = await validateChromePromptApiFeasibilityReport(
      createChromePromptApiReportWithEnvelope(
        report,
        createChromePromptApiSyntheticEnvelope(report),
      ),
    );

    expect(result.status).toBe('valid');
    expect(result.readiness).toBe('synthetic');
    expect(result.readiness).not.toBe('real-browser-verified');
  });

  it('labels a report carrying a self-reported envelope as self-reported only', async () => {
    const report = createChromePromptApiReport();
    const result = await validateChromePromptApiFeasibilityReport(
      createChromePromptApiReportWithEnvelope(
        report,
        createChromePromptApiSelfReportedEnvelope(report),
      ),
    );

    expect(result.status).toBe('valid');
    expect(result.readiness).toBe('self-reported');
  });

  it('never lets a hand-written captured-and-verified fixture claim verified without loader and verifier', async () => {
    // The fixture wraps itself in a captured-and-verified envelope, but no
    // artifact loader or independent verifier is supplied: it must be
    // 'not-evaluated', never 'real-browser-verified'.
    const report = createChromePromptApiReport();
    const result = await validateChromePromptApiFeasibilityReport(
      createChromePromptApiReportWithEnvelope(
        report,
        createChromePromptApiCapturedEnvelope(report),
      ),
      {
        evidenceValidation: {
          now: '2026-07-10T14:00:00.000Z',
          trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }],
        },
      },
    );

    expect(result.status).toBe('valid');
    expect(result.readiness).toBe('not-evaluated');
    expect(result.readiness).not.toBe('real-browser-verified');
    expect(result.evidenceValidation?.status).toBe('not-evaluated');
    expect(result.evidenceValidation?.issues).toContainEqual(
      expect.objectContaining({ code: 'artifact-unavailable' }),
    );
  });

  it('ignores a hand-written readiness field on the report object', async () => {
    // Even if a fixture writes `readiness: 'real-browser-verified'` directly on
    // the report, the validator derives readiness from the envelope only.
    const report = createChromePromptApiReport();
    const result = await validateChromePromptApiFeasibilityReport({
      ...report,
      readiness: 'real-browser-verified',
    });

    expect(result.status).toBe('valid');
    expect(result.readiness).toBe('self-reported');
  });

  it('accepts captured-and-verified evidence only when loader, verifier, and trust list validate', async () => {
    const report = createChromePromptApiReport();
    const result = await validateChromePromptApiFeasibilityReport(
      createChromePromptApiReportWithEnvelope(
        report,
        createChromePromptApiCapturedEnvelope(report),
      ),
      { evidenceValidation: createVerifiedValidationOptions() },
    );

    expect(result.status).toBe('valid');
    expect(result.readiness).toBe('real-browser-verified');
    expect(result.evidenceValidation?.status).toBe('valid');
    expect(result.evidenceValidation?.effectiveEvidenceLevel).toBe('captured-and-verified');
  });

  it('labels a report whose captured envelope fails freshness as not-evaluated', async () => {
    const report = createChromePromptApiReport();
    const reportWithEnvelope = createChromePromptApiReportWithEnvelope(
      report,
      createChromePromptApiCapturedEnvelope(report, {
        artifact: {
          locator: 'artifact://browser-run-1/report.json',
          sha256: '2127de9293abf1503418b9f78b3d530cdd2263417064815ee46b7ecdf1215ddc',
          expiresAt: '2026-07-09T13:00:00.000Z',
        },
      }),
    );

    const result = await validateChromePromptApiFeasibilityReport(reportWithEnvelope, {
      evidenceValidation: createVerifiedValidationOptions(),
    });

    expect(result.status).toBe('valid');
    expect(result.readiness).toBe('not-evaluated');
    expect(result.evidenceValidation?.issues).toContainEqual(
      expect.objectContaining({ code: 'expired-artifact' }),
    );
  });
});

describe('ChromePromptApiFeasibilityReport decision gate (Go / No-Go)', () => {
  it('records 未解決条件 (not-evaluated) until real-browser evidence exists', async () => {
    const decision = await evaluateChromePromptApiFeasibilityDecision(
      createChromePromptApiReport(),
    );

    expect(decision.decision).toBe('not-evaluated');
    expect(decision.blockingConditions).toEqual(['real-browser-evidence']);
    expect(decision.conditions.find((condition) => condition.name === 'real-browser-evidence'))
      .toMatchObject({ status: 'pending' });
    // Even a fully passing self-reported fixture stays pending: a hand-written
    // report cannot produce a Go decision.
    expect(decision.conditions.every((condition) => condition.status !== 'met')).toBe(true);
  });

  it('records Go only for a validated real-browser report with every condition met', async () => {
    const report = createChromePromptApiReport();
    const decision = await evaluateChromePromptApiFeasibilityDecision(
      createChromePromptApiReportWithEnvelope(
        report,
        createChromePromptApiCapturedEnvelope(report),
      ),
      { evidenceValidation: createVerifiedValidationOptions() },
    );

    expect(decision.decision).toBe('go');
    expect(decision.blockingConditions).toEqual([]);
    expect(decision.conditions.every((condition) => condition.status === 'met')).toBe(true);
  });

  it('records No-Go when a real-browser scenario fails', async () => {
    const report = createChromePromptApiReport({}, {
      'prompt-streaming': { scenarioStatus: 'fail' },
    });
    const decision = await evaluateChromePromptApiFeasibilityDecision(
      createChromePromptApiReportWithEnvelope(
        report,
        createChromePromptApiCapturedEnvelope(report),
      ),
      { evidenceValidation: createVerifiedValidationOptions() },
    );

    expect(decision.decision).toBe('no-go');
    expect(decision.blockingConditions).toEqual(['prompt-streaming']);
  });

  it('records Conditional-Go when a real-browser scenario is not applicable', async () => {
    const report = createChromePromptApiReport({}, {
      'concurrent-sessions': { scenarioStatus: 'not-applicable' },
    });
    const decision = await evaluateChromePromptApiFeasibilityDecision(
      createChromePromptApiReportWithEnvelope(
        report,
        createChromePromptApiCapturedEnvelope(report),
      ),
      { evidenceValidation: createVerifiedValidationOptions() },
    );

    expect(decision.decision).toBe('conditional-go');
    expect(decision.blockingConditions).toEqual(['concurrent-sessions']);
  });

  it('integration: validates the captured envelope directly through evidence.ts', async () => {
    // Proves the feasibility report's captured-and-verified path is backed by
    // the shared evidence.ts validator rather than a bespoke check.
    const validation = await validateEvidenceEnvelope(
      createChromePromptApiCapturedEnvelope(),
      createVerifiedValidationOptions(),
    );

    expect(validation.status).toBe('valid');
    expect(validation.effectiveEvidenceLevel).toBe('captured-and-verified');
  });
});

describe('Chrome Prompt API harness / schema drift guard', () => {
  it('keeps every harness scenario discriminator in sync with the schema', () => {
    // The browser harness duplicates the scenario names as plain strings (it
    // cannot import the TS schema). Guard against silent drift by comparing the
    // names the harness emits with the schema-derived fixture records.
    const harnessSource = readFileSync(
      join(import.meta.dirname, '..', 'browser-harness', 'chrome-prompt-api', 'harness.js'),
      'utf8',
    );
    const harnessScenarios = new Set(
      Array.from(harnessSource.matchAll(/scenario:\s*'([a-z-]+)'/g), (match) => match[1]),
    );
    const schemaScenarios = new Set(
      createScenarioRecords().map((record) => record.scenario),
    );

    expect(harnessScenarios.size).toBeGreaterThan(0);
    expect(harnessScenarios).toEqual(schemaScenarios);
  });
});
