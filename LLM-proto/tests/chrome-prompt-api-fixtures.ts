/**
 * Fixture builders for the Chrome Prompt API feasibility report contract tests
 * (issue #93).
 *
 * Every fixture produced here is a hand-written object: it can exercise the
 * schema validator and decision gate, but it must NEVER be able to claim
 * 'real-browser-verified' on its own. Verified status only appears when the
 * caller passes a captured-and-verified EvidenceEnvelope together with an
 * artifact loader and an independent verifier (see evidence.ts), which a
 * fixture file cannot fabricate.
 */

import {
  EVIDENCE_SCHEMA_VERSION,
  type CapturedAndVerifiedEvidenceEnvelope,
  type EvidenceEnvelope,
} from '../src/evidence.js';
import {
  CHROME_PROMPT_API_REPORT_SCHEMA_VERSION,
  type ChromePromptApiFeasibilityReport,
  type ChromePromptApiScenarioRecord,
  type ChromePromptApiSurfaceEntry,
} from '../src/chrome-prompt-api-report.js';
import {
  createCapturedAndVerifiedEnvelope,
} from './evidence-envelope-helpers.js';

// Fixed capture clock in the past so envelope freshness checks (evidence.ts)
// never reject the fixture as future-dated or expired against Date.now().
export const CHROME_PROMPT_API_NOW = '2026-07-01T12:00:00.000Z';
export const CHROME_PROMPT_API_RUN_ID = 'fixture-prompt-api-run-1';

// Payload carried inside an EvidenceEnvelope: the self-reported run data that
// an operator would later wrap with an artifact + independent verification.
export interface ChromePromptApiEvidencePayload {
  readonly runId: string;
  readonly capturedAt: string;
  readonly scenarios: readonly ChromePromptApiScenarioRecord[];
}

export function createSurfaceMatrix(
  surfaces: readonly ChromePromptApiSurfaceEntry[] = [],
): ChromePromptApiSurfaceEntry[] {
  if (surfaces.length > 0) {
    return [...surfaces];
  }
  return [
    {
      surface: 'top-level',
      tested: true,
      available: true,
      usable: true,
      createAllowed: true,
    },
    {
      surface: 'same-origin-iframe',
      tested: true,
      available: true,
      usable: true,
      createAllowed: true,
    },
    {
      surface: 'sandbox-iframe',
      tested: true,
      available: false,
      usable: false,
      createAllowed: false,
      note: 'sandbox iframe does not expose the Prompt API (permission policy)',
    },
    {
      surface: 'cross-origin-iframe',
      tested: false,
      available: false,
      usable: false,
      createAllowed: false,
      note: 'requires a separately served cross-origin URL; not testable from this page',
    },
    {
      surface: 'extension-page',
      tested: false,
      available: false,
      usable: false,
      createAllowed: false,
      note: 'requires an extension host; not testable from this page',
    },
  ];
}

export function createScenarioRecords(
  overrides: Readonly<Record<string, Partial<ChromePromptApiScenarioRecord>>> = {},
): ChromePromptApiScenarioRecord[] {
  const records: ChromePromptApiScenarioRecord[] = [
    {
      scenario: 'availability-state-transitions',
      scenarioStatus: 'pass',
      apiAvailable: true,
      observedAvailabilityStates: ['downloadable', 'downloading', 'available'],
      observedTransitionSequence: ['downloadable', 'downloading', 'available'],
      finalAvailabilityState: 'available',
      availabilitySamples: [
        { state: 'downloadable', atMs: 1_700_000_000_000 },
        { state: 'downloading', atMs: 1_700_000_000_500 },
        { state: 'available', atMs: 1_700_000_010_000 },
      ],
    },
    {
      scenario: 'create-without-user-activation',
      scenarioStatus: 'pass',
      createRejected: true,
      createErrorCategory: 'not-allowed',
      userActivationRequired: true,
      rejectionMessage: 'create() requires a user activation for the first model download',
    },
    {
      scenario: 'create-after-user-activation',
      scenarioStatus: 'pass',
      createSucceeded: true,
      sessionCreateMs: 1250,
      firstDownloadObserved: true,
    },
    {
      scenario: 'download-progress-monitor',
      scenarioStatus: 'pass',
      monitorSupported: true,
      downloadState: 'downloaded',
      downloadComplete: true,
      downloadProgressSamples: [
        { loadedTokens: 10, totalTokens: 100, atMs: 1_700_000_001_000 },
        { loadedTokens: 55, totalTokens: 100, atMs: 1_700_000_005_000 },
        { loadedTokens: 100, totalTokens: 100, atMs: 1_700_000_010_000 },
      ],
    },
    {
      scenario: 'prompt-non-streaming',
      scenarioStatus: 'pass',
      success: true,
      sessionCreateMs: 1250,
      timeToFirstTokenMs: 512,
      totalTokens: 42,
      tokensPerSec: 82,
      promptLanguage: 'en',
      outputLanguage: 'en',
    },
    {
      scenario: 'prompt-streaming',
      scenarioStatus: 'pass',
      success: true,
      sessionCreateMs: 1250,
      timeToFirstChunkMs: 88,
      timeToFirstTokenMs: 210,
      totalTokens: 48,
      tokensPerSec: 96,
      chunkCount: 14,
      promptLanguage: 'en',
      outputLanguage: 'en',
    },
    {
      scenario: 'expected-inputs-outputs',
      scenarioStatus: 'pass',
      expectedInputsAccepted: true,
      expectedOutputsAccepted: true,
      japaneseInputAccepted: true,
      japaneseOutputProduced: true,
      promptLanguage: 'ja',
      outputLanguage: 'ja',
      observedOutputSample: 'これはテストです',
    },
    {
      scenario: 'abort-interruption',
      scenarioStatus: 'pass',
      abortSupported: true,
      abortOrErrorCategory: 'aborted',
      timeToAbortMs: 96,
      outputTruncated: true,
    },
    {
      scenario: 'context-usage-and-overflow',
      scenarioStatus: 'pass',
      contextUsage: { usedTokens: 1200, totalTokens: 8000, ratio: 0.15 },
      contextWindow: { min: 1000, max: 8000 },
      contextOverflowObserved: false,
      quotaErrorObserved: false,
      abortOrErrorCategory: 'no-error',
    },
    {
      scenario: 'session-destroy-recreate',
      scenarioStatus: 'pass',
      destroySucceeded: true,
      recreateSucceeded: true,
      destroyRecreateMs: 812,
    },
    {
      scenario: 'concurrent-sessions',
      scenarioStatus: 'pass',
      sessionCount: 4,
      executionCount: 4,
      maxConcurrentSupported: true,
      concurrentSessionErrors: 0,
    },
    {
      scenario: 'surface-matrix',
      scenarioStatus: 'pass',
      surfaces: createSurfaceMatrix(),
    },
  ];
  return records.map((record) => {
    const override = overrides[record.scenario];
    return override
      ? ({ ...record, ...override } as ChromePromptApiScenarioRecord)
      : record;
  });
}

export function createChromePromptApiReport(
  overrides: Partial<ChromePromptApiFeasibilityReport> = {},
  scenarioOverrides: Readonly<Record<string, Partial<ChromePromptApiScenarioRecord>>> = {},
): ChromePromptApiFeasibilityReport {
  return {
    schemaVersion: CHROME_PROMPT_API_REPORT_SCHEMA_VERSION,
    reportKind: 'chrome-prompt-api-feasibility',
    producer: { name: 'unzen-chrome-prompt-api-harness', version: '0.1.0' },
    runId: CHROME_PROMPT_API_RUN_ID,
    capturedAt: CHROME_PROMPT_API_NOW,
    environment: {
      chromeVersion: '150.0.0.0',
      chromeChannel: 'stable',
      os: 'macOS',
      osVersion: '15.5',
      arch: 'arm64',
      hardwareConcurrency: 8,
      deviceMemoryGB: 16,
      language: 'en-US',
    },
    scenarios: createScenarioRecords(scenarioOverrides),
    ...overrides,
  };
}

export function createChromePromptApiEvidencePayload(
  report: ChromePromptApiFeasibilityReport = createChromePromptApiReport(),
): ChromePromptApiEvidencePayload {
  return {
    runId: report.runId,
    capturedAt: report.capturedAt,
    scenarios: report.scenarios,
  };
}

// Synthetic envelope: proves a report with a fixture envelope can only ever be
// labeled 'synthetic', never 'real-browser-verified'.
export function createChromePromptApiSyntheticEnvelope(
  report: ChromePromptApiFeasibilityReport = createChromePromptApiReport(),
): EvidenceEnvelope<ChromePromptApiEvidencePayload> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'chrome-prompt-api-feasibility',
    evidenceLevel: 'synthetic-fixture',
    readinessStatus: 'contract-tested',
    producer: { name: 'vitest', version: '4.1.7' },
    runId: report.runId,
    capturedAt: report.capturedAt,
    environment: {
      runtime: 'node',
      runtimeVersion: '22.16.0',
      executionSurface: 'unit-test',
    },
    redaction: { applied: false, policyVersion: 'none' },
    payload: createChromePromptApiEvidencePayload(report),
  };
}

// Captured-and-verified envelope built by hand. It stays 'not-evaluated' unless
// the caller supplies an artifact loader and an independent verifier (which a
// fixture cannot), so this is the core "hand-written fixture cannot claim
// verified" acceptance test.
export function createChromePromptApiCapturedEnvelope(
  report: ChromePromptApiFeasibilityReport = createChromePromptApiReport(),
  overrides: Partial<CapturedAndVerifiedEvidenceEnvelope<ChromePromptApiEvidencePayload>> = {},
): EvidenceEnvelope<ChromePromptApiEvidencePayload> {
  return createCapturedAndVerifiedEnvelope<ChromePromptApiEvidencePayload>(
    createChromePromptApiEvidencePayload(report),
    { evidenceKind: 'chrome-prompt-api-feasibility', ...overrides },
  );
}

// Self-reported-runtime envelope: the runtime's own report, which can only ever
// be labeled 'self-reported'.
export function createChromePromptApiSelfReportedEnvelope(
  report: ChromePromptApiFeasibilityReport = createChromePromptApiReport(),
): EvidenceEnvelope<ChromePromptApiEvidencePayload> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'chrome-prompt-api-feasibility',
    evidenceLevel: 'self-reported-runtime',
    readinessStatus: 'runtime-observed',
    producer: { name: 'vitest', version: '4.1.7' },
    runId: report.runId,
    capturedAt: report.capturedAt,
    environment: {
      runtime: 'node',
      runtimeVersion: '22.16.0',
      executionSurface: 'unit-test',
    },
    redaction: { applied: false, policyVersion: 'none' },
    payload: createChromePromptApiEvidencePayload(report),
  };
}

export function createChromePromptApiReportWithEnvelope(
  report: ChromePromptApiFeasibilityReport,
  envelope: EvidenceEnvelope<ChromePromptApiEvidencePayload>,
): ChromePromptApiFeasibilityReport {
  return { ...report, evidence: envelope };
}
