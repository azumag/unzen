/**
 * Chrome Prompt API feasibility report schema, validator, and decision gate
 * (issue #93).
 *
 * The Chrome Built-in AI / Prompt API is a candidate inference resource for
 * Unzen, but it lives in the DOCUMENT execution context (not a Dedicated Web
 * Worker) and its model preparation has its own lifecycle (availability, user
 * activation, first download, language). This module defines the report that a
 * human-run browser harness produces plus the validator that decides how much
 * of that report is trusted.
 *
 * Provenance rule (mirrors evidence.ts / workers-coordinator-signed-runner-
 * evidence.ts): the report carries no hand-written readiness field. Readiness
 * is DERIVED from an optional EvidenceEnvelope via validateEvidenceEnvelope().
 * A report without a validated captured-and-verified envelope is labeled
 * 'synthetic' or 'self-reported', never 'real-browser-verified', so a
 * hand-written fixture cannot mint verified status by writing fields. A
 * captured-and-verified envelope only validates when the caller supplies an
 * artifact loader and an independent verifier callback, which a fixture cannot
 * fabricate.
 */

import {
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
  type EvidenceValidationResult,
} from './evidence.js';

export const CHROME_PROMPT_API_REPORT_SCHEMA_VERSION = '1.0.0' as const;

// --- scenario / surface enums -------------------------------------------------

export type ChromePromptApiAvailabilityState =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

export type ChromePromptApiDownloadState =
  | 'not-started'
  | 'downloading'
  | 'downloaded'
  | 'not-applicable';

export type ChromePromptApiScenarioStatus = 'pass' | 'fail' | 'not-applicable';

export type ChromePromptApiScenarioName =
  | 'availability-state-transitions'
  | 'create-without-user-activation'
  | 'create-after-user-activation'
  | 'download-progress-monitor'
  | 'prompt-non-streaming'
  | 'prompt-streaming'
  | 'expected-inputs-outputs'
  | 'abort-interruption'
  | 'context-usage-and-overflow'
  | 'session-destroy-recreate'
  | 'concurrent-sessions'
  | 'surface-matrix';

export type ChromePromptApiAbortOrErrorCategory =
  | 'no-error'
  | 'aborted'
  | 'quota-error'
  | 'context-overflow'
  | 'invalid-argument'
  | 'not-allowed'
  | 'internal'
  | 'unknown';

export type ChromePromptApiExecutionSurface =
  | 'top-level'
  | 'same-origin-iframe'
  | 'sandbox-iframe'
  | 'cross-origin-iframe'
  | 'extension-page';

// --- scenario records ----------------------------------------------------------

interface ChromePromptApiScenarioRecordBase {
  readonly scenarioStatus: ChromePromptApiScenarioStatus;
  readonly skippedReason?: string;
}

export interface ChromePromptApiAvailabilityTransitionsRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'availability-state-transitions';
  readonly apiAvailable: boolean;
  readonly observedAvailabilityStates: readonly ChromePromptApiAvailabilityState[];
  readonly observedTransitionSequence: readonly string[];
  readonly finalAvailabilityState: ChromePromptApiAvailabilityState;
  readonly availabilitySamples: readonly {
    readonly state: ChromePromptApiAvailabilityState;
    readonly atMs: number;
  }[];
}

export interface ChromePromptApiCreateWithoutUserActivationRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'create-without-user-activation';
  readonly createRejected: boolean;
  readonly createErrorCategory: ChromePromptApiAbortOrErrorCategory;
  readonly userActivationRequired: boolean;
  readonly rejectionMessage?: string;
}

export interface ChromePromptApiCreateAfterUserActivationRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'create-after-user-activation';
  readonly createSucceeded: boolean;
  readonly sessionCreateMs: number;
  readonly firstDownloadObserved: boolean;
  readonly createErrorCategory?: ChromePromptApiAbortOrErrorCategory;
}

export interface ChromePromptApiDownloadProgressMonitorRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'download-progress-monitor';
  readonly monitorSupported: boolean;
  readonly downloadState: ChromePromptApiDownloadState;
  readonly downloadComplete: boolean;
  readonly downloadProgressSamples: readonly {
    readonly loadedTokens: number;
    readonly totalTokens: number;
    readonly atMs: number;
  }[];
}

export interface ChromePromptApiPromptNonStreamingRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'prompt-non-streaming';
  readonly success: boolean;
  readonly sessionCreateMs: number;
  readonly timeToFirstTokenMs: number;
  readonly totalTokens: number;
  readonly tokensPerSec: number;
  readonly promptLanguage: string;
  readonly outputLanguage: string;
  readonly errorCategory?: ChromePromptApiAbortOrErrorCategory;
}

export interface ChromePromptApiPromptStreamingRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'prompt-streaming';
  readonly success: boolean;
  readonly sessionCreateMs: number;
  readonly timeToFirstChunkMs: number;
  readonly timeToFirstTokenMs: number;
  readonly totalTokens: number;
  readonly tokensPerSec: number;
  readonly chunkCount: number;
  readonly promptLanguage: string;
  readonly outputLanguage: string;
  readonly errorCategory?: ChromePromptApiAbortOrErrorCategory;
}

export interface ChromePromptApiExpectedInputsOutputsRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'expected-inputs-outputs';
  readonly expectedInputsAccepted: boolean;
  readonly expectedOutputsAccepted: boolean;
  readonly japaneseInputAccepted: boolean;
  readonly japaneseOutputProduced: boolean;
  readonly promptLanguage: string;
  readonly outputLanguage: string;
  readonly observedOutputSample?: string;
}

export interface ChromePromptApiAbortInterruptionRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'abort-interruption';
  readonly abortSupported: boolean;
  readonly abortOrErrorCategory: ChromePromptApiAbortOrErrorCategory;
  readonly timeToAbortMs: number;
  readonly outputTruncated: boolean;
}

export interface ChromePromptApiContextUsageAndOverflowRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'context-usage-and-overflow';
  readonly contextUsage: {
    readonly usedTokens: number;
    readonly totalTokens: number;
    readonly ratio: number;
  };
  readonly contextWindow: {
    readonly min: number;
    readonly max: number;
  };
  readonly contextOverflowObserved: boolean;
  readonly quotaErrorObserved: boolean;
  readonly abortOrErrorCategory: ChromePromptApiAbortOrErrorCategory;
}

export interface ChromePromptApiSessionDestroyRecreateRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'session-destroy-recreate';
  readonly destroySucceeded: boolean;
  readonly recreateSucceeded: boolean;
  readonly destroyRecreateMs: number;
}

export interface ChromePromptApiConcurrentSessionsRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'concurrent-sessions';
  readonly sessionCount: number;
  readonly executionCount: number;
  readonly maxConcurrentSupported: boolean;
  readonly concurrentSessionErrors: number;
}

export interface ChromePromptApiSurfaceEntry {
  readonly surface: ChromePromptApiExecutionSurface;
  readonly tested: boolean;
  readonly available: boolean;
  readonly usable: boolean;
  readonly createAllowed: boolean;
  readonly errorCategory?: ChromePromptApiAbortOrErrorCategory;
  readonly note?: string;
}

export interface ChromePromptApiSurfaceMatrixRecord
  extends ChromePromptApiScenarioRecordBase {
  readonly scenario: 'surface-matrix';
  readonly surfaces: readonly ChromePromptApiSurfaceEntry[];
}

export type ChromePromptApiScenarioRecord =
  | ChromePromptApiAvailabilityTransitionsRecord
  | ChromePromptApiCreateWithoutUserActivationRecord
  | ChromePromptApiCreateAfterUserActivationRecord
  | ChromePromptApiDownloadProgressMonitorRecord
  | ChromePromptApiPromptNonStreamingRecord
  | ChromePromptApiPromptStreamingRecord
  | ChromePromptApiExpectedInputsOutputsRecord
  | ChromePromptApiAbortInterruptionRecord
  | ChromePromptApiContextUsageAndOverflowRecord
  | ChromePromptApiSessionDestroyRecreateRecord
  | ChromePromptApiConcurrentSessionsRecord
  | ChromePromptApiSurfaceMatrixRecord;

// --- report --------------------------------------------------------------------

export interface ChromePromptApiEnvironment {
  readonly chromeVersion: string;
  readonly chromeChannel: string;
  readonly os: string;
  readonly osVersion: string;
  readonly arch?: string;
  readonly hardwareConcurrency?: number;
  readonly deviceMemoryGB?: number;
  readonly gpuRenderer?: string;
  readonly language?: string;
}

export interface ChromePromptApiFeasibilityReport {
  readonly schemaVersion: string;
  readonly reportKind: 'chrome-prompt-api-feasibility';
  readonly producer: {
    readonly name: string;
    readonly version: string;
  };
  readonly runId: string;
  readonly capturedAt: string;
  readonly environment: ChromePromptApiEnvironment;
  readonly scenarios: readonly ChromePromptApiScenarioRecord[];
  readonly evidence?: EvidenceEnvelope;
  readonly notes?: readonly string[];
}

// --- validation ------------------------------------------------------------------

export type ChromePromptApiReadiness =
  | 'synthetic'
  | 'self-reported'
  | 'not-evaluated'
  | 'real-browser-verified';

export interface ChromePromptApiValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ChromePromptApiValidationResult {
  readonly status: 'valid' | 'invalid';
  readonly readiness: ChromePromptApiReadiness;
  readonly report?: ChromePromptApiFeasibilityReport;
  readonly issues: readonly ChromePromptApiValidationIssue[];
  readonly evidenceValidation?: EvidenceValidationResult;
}

export interface ChromePromptApiReportValidationOptions {
  readonly supportedSchemaVersions?: readonly string[];
  // Trust boundary for the optional captured-and-verified envelope: the
  // verifier trust list, artifact loader, and independent verifier callback
  // must come from outside the report, exactly like the signed-runner gates.
  readonly evidenceValidation?: EvidenceValidationOptions;
}

const AVAILABILITY_STATES: readonly ChromePromptApiAvailabilityState[] = [
  'unavailable',
  'downloadable',
  'downloading',
  'available',
];
const DOWNLOAD_STATES: readonly ChromePromptApiDownloadState[] = [
  'not-started',
  'downloading',
  'downloaded',
  'not-applicable',
];
const SCENARIO_STATUSES: readonly ChromePromptApiScenarioStatus[] = [
  'pass',
  'fail',
  'not-applicable',
];
const ERROR_CATEGORIES: readonly ChromePromptApiAbortOrErrorCategory[] = [
  'no-error',
  'aborted',
  'quota-error',
  'context-overflow',
  'invalid-argument',
  'not-allowed',
  'internal',
  'unknown',
];
const SURFACES: readonly ChromePromptApiExecutionSurface[] = [
  'top-level',
  'same-origin-iframe',
  'sandbox-iframe',
  'cross-origin-iframe',
  'extension-page',
];
const SCENARIO_NAMES = new Set<ChromePromptApiScenarioName>([
  'availability-state-transitions',
  'create-without-user-activation',
  'create-after-user-activation',
  'download-progress-monitor',
  'prompt-non-streaming',
  'prompt-streaming',
  'expected-inputs-outputs',
  'abort-interruption',
  'context-usage-and-overflow',
  'session-destroy-recreate',
  'concurrent-sessions',
  'surface-matrix',
]);

/**
 * Validate a Chrome Prompt API feasibility report. The report schema itself is
 * checked strictly; the readiness label is always DERIVED from the optional
 * evidence envelope and never from fields a fixture could hand-write.
 */
export async function validateChromePromptApiFeasibilityReport(
  input: unknown,
  options: ChromePromptApiReportValidationOptions = {},
): Promise<ChromePromptApiValidationResult> {
  const issues: ChromePromptApiValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      status: 'invalid',
      readiness: 'not-evaluated',
      issues: [
        { code: 'invalid-report', path: '$', message: 'report must be an object' },
      ],
    };
  }

  const supported = options.supportedSchemaVersions
    ?? [CHROME_PROMPT_API_REPORT_SCHEMA_VERSION];
  if (typeof input.schemaVersion === 'string' && !supported.includes(input.schemaVersion)) {
    issue(issues, 'unsupported-schema-version', '$.schemaVersion',
      `unsupported report schema version: ${input.schemaVersion}`);
  }
  if (input.reportKind !== 'chrome-prompt-api-feasibility') {
    issue(issues, 'invalid-report-kind', '$.reportKind',
      "reportKind must be 'chrome-prompt-api-feasibility'");
  }
  if (!isRecord(input.producer) || !isNonEmptyString(input.producer.name) ||
      !isNonEmptyString(input.producer.version)) {
    issue(issues, 'invalid-producer', '$.producer',
      'producer.name and producer.version must be non-empty strings');
  }
  if (!isNonEmptyString(input.runId)) {
    issue(issues, 'missing-run-id', '$.runId', 'runId must be a non-empty string');
  }
  if (!isNonEmptyString(input.capturedAt) || Number.isNaN(Date.parse(input.capturedAt))) {
    issue(issues, 'invalid-timestamp', '$.capturedAt',
      'capturedAt must be a valid ISO timestamp');
  }
  validateEnvironment(input.environment, issues);
  validateScenarios(input.scenarios, issues);

  let evidenceValidation: EvidenceValidationResult | undefined;
  if (input.evidence !== undefined) {
    evidenceValidation = await validateEvidenceEnvelope(
      input.evidence,
      options.evidenceValidation ?? {},
    );
  }
  const readiness = deriveReadiness(evidenceValidation, input.evidence !== undefined);

  if (issues.length > 0) {
    return { status: 'invalid', readiness, issues, evidenceValidation };
  }
  return {
    status: 'valid',
    readiness,
    report: input as unknown as ChromePromptApiFeasibilityReport,
    issues,
    evidenceValidation,
  };
}

// --- decision gate --------------------------------------------------------------

export type ChromePromptApiDecision = 'go' | 'conditional-go' | 'no-go' | 'not-evaluated';

export interface ChromePromptApiDecisionCondition {
  readonly name: string;
  readonly status: 'met' | 'unmet' | 'pending' | 'failed';
  readonly reason: string;
}

export interface ChromePromptApiDecisionRecord {
  readonly decision: ChromePromptApiDecision;
  readonly conditions: readonly ChromePromptApiDecisionCondition[];
  readonly blockingConditions: readonly string[];
}

// Conditions that must ALL be met before the Chrome backend can be recorded as
// a feasible Unzen inference resource. A report without validated real-browser
// evidence stays 'not-evaluated' (未解決条件), matching the "pending real-browser
// measurement" recording the README/PLAN tables must show.
const SCENARIO_DECISION_ORDER: readonly {
  readonly name: string;
  readonly scenario: ChromePromptApiScenarioName;
}[] = [
  { name: 'prompt-api-availability', scenario: 'availability-state-transitions' },
  { name: 'create-after-user-activation', scenario: 'create-after-user-activation' },
  { name: 'first-download-preparation', scenario: 'download-progress-monitor' },
  { name: 'prompt-non-streaming', scenario: 'prompt-non-streaming' },
  { name: 'prompt-streaming', scenario: 'prompt-streaming' },
  { name: 'japanese-input-output', scenario: 'expected-inputs-outputs' },
  { name: 'abort-interruption', scenario: 'abort-interruption' },
  { name: 'context-usage-and-overflow', scenario: 'context-usage-and-overflow' },
  { name: 'session-lifecycle', scenario: 'session-destroy-recreate' },
  { name: 'concurrent-sessions', scenario: 'concurrent-sessions' },
  { name: 'surface-matrix', scenario: 'surface-matrix' },
];

/**
 * Derive the Go / Conditional Go / No-Go / 未解決条件 recording for a Chrome
 * Prompt API feasibility run. The gate is intentionally conservative: without a
 * validated captured-and-verified envelope the decision is always
 * 'not-evaluated', so a hand-written fixture can never be recorded as Go.
 */
export async function evaluateChromePromptApiFeasibilityDecision(
  input: unknown,
  options: ChromePromptApiReportValidationOptions = {},
): Promise<ChromePromptApiDecisionRecord> {
  const validation = await validateChromePromptApiFeasibilityReport(input, options);
  const verified = validation.readiness === 'real-browser-verified';

  const conditions: ChromePromptApiDecisionCondition[] = [];
  if (verified) {
    conditions.push({
      name: 'real-browser-evidence',
      status: 'met',
      reason: 'captured-and-verified envelope validated with artifact loader and verifier',
    });
  } else {
    conditions.push({
      name: 'real-browser-evidence',
      status: 'pending',
      reason: validation.readiness === 'not-evaluated'
        ? 'pending real-browser measurement'
        : `readiness is ${validation.readiness}; captured-and-verified evidence required`,
    });
  }
  for (const entry of SCENARIO_DECISION_ORDER) {
    conditions.push(conditionForScenario(verified, validation.report, entry));
  }

  const evidenceCondition = conditions[0];
  const failed = conditions.filter((condition) => condition.status === 'failed');
  const pending = conditions.filter((condition) => condition.status === 'pending');

  if (evidenceCondition.status !== 'met') {
    return {
      decision: 'not-evaluated',
      conditions,
      blockingConditions: ['real-browser-evidence'],
    };
  }
  if (failed.length > 0) {
    return {
      decision: 'no-go',
      conditions,
      blockingConditions: failed.map((condition) => condition.name),
    };
  }
  if (pending.length > 0) {
    return {
      decision: 'conditional-go',
      conditions,
      blockingConditions: pending.map((condition) => condition.name),
    };
  }
  return { decision: 'go', conditions, blockingConditions: [] };
}

// --- validation helpers ---------------------------------------------------------

function validateEnvironment(input: unknown, issues: ChromePromptApiValidationIssue[]): void {
  if (!isRecord(input)) {
    issue(issues, 'invalid-environment', '$.environment', 'environment must be an object');
    return;
  }
  requireStringField(input, 'chromeVersion', '$.environment.chromeVersion', issues);
  requireStringField(input, 'chromeChannel', '$.environment.chromeChannel', issues);
  requireStringField(input, 'os', '$.environment.os', issues);
  requireStringField(input, 'osVersion', '$.environment.osVersion', issues);
  optionalNonNegativeNumber(input, 'hardwareConcurrency', '$.environment.hardwareConcurrency', issues);
  optionalNonNegativeNumber(input, 'deviceMemoryGB', '$.environment.deviceMemoryGB', issues);
}

function validateScenarios(input: unknown, issues: ChromePromptApiValidationIssue[]): void {
  if (!Array.isArray(input)) {
    issue(issues, 'invalid-scenarios', '$.scenarios', 'scenarios must be an array');
    return;
  }
  if (input.length === 0) {
    issue(issues, 'invalid-scenarios', '$.scenarios', 'scenarios must not be empty');
    return;
  }
  input.forEach((record, index) => {
    const path = `$.scenarios[${index}]`;
    if (!isRecord(record)) {
      issue(issues, 'invalid-scenario', path, 'scenario must be an object');
      return;
    }
    if (typeof record.scenario !== 'string' || !SCENARIO_NAMES.has(record.scenario as ChromePromptApiScenarioName)) {
      issue(issues, 'invalid-scenario', `${path}.scenario`, 'unknown scenario discriminator');
      return;
    }
    if (!SCENARIO_STATUSES.includes(record.scenarioStatus as ChromePromptApiScenarioStatus)) {
      issue(issues, 'invalid-scenario-status', `${path}.scenarioStatus`,
        'scenarioStatus must be pass, fail, or not-applicable');
    }
    const scenario = record as unknown as ChromePromptApiScenarioRecord;
    validateScenarioFields(scenario, path, issues);
  });
}

function validateScenarioFields(
  scenario: ChromePromptApiScenarioRecord,
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  // The scenario records are typed interfaces without an index signature; the
  // field helpers operate on records, so narrow once here.
  const record = scenario as unknown as Record<string, unknown>;
  switch (scenario.scenario) {
    case 'availability-state-transitions':
      requireBoolean(record, 'apiAvailable', `${path}.apiAvailable`, issues);
      requireStringArray(record, 'observedAvailabilityStates', `${path}.observedAvailabilityStates`, issues);
      for (const state of scenario.observedAvailabilityStates) {
        if (!AVAILABILITY_STATES.includes(state)) {
          issue(issues, 'invalid-availability-state', `${path}.observedAvailabilityStates`, `unknown availability state: ${state}`);
        }
      }
      requireStringArray(record, 'observedTransitionSequence', `${path}.observedTransitionSequence`, issues);
      requireEnum(record, 'finalAvailabilityState', AVAILABILITY_STATES, `${path}.finalAvailabilityState`, issues);
      requireRecordArray(record, 'availabilitySamples', `${path}.availabilitySamples`, issues);
      break;
    case 'create-without-user-activation':
      requireBoolean(record, 'createRejected', `${path}.createRejected`, issues);
      requireEnum(record, 'createErrorCategory', ERROR_CATEGORIES, `${path}.createErrorCategory`, issues);
      requireBoolean(record, 'userActivationRequired', `${path}.userActivationRequired`, issues);
      break;
    case 'create-after-user-activation':
      requireBoolean(record, 'createSucceeded', `${path}.createSucceeded`, issues);
      requireNonNegativeNumber(record, 'sessionCreateMs', `${path}.sessionCreateMs`, issues);
      requireBoolean(record, 'firstDownloadObserved', `${path}.firstDownloadObserved`, issues);
      optionalEnum(record, 'createErrorCategory', ERROR_CATEGORIES, `${path}.createErrorCategory`, issues);
      break;
    case 'download-progress-monitor':
      requireBoolean(record, 'monitorSupported', `${path}.monitorSupported`, issues);
      requireEnum(record, 'downloadState', DOWNLOAD_STATES, `${path}.downloadState`, issues);
      requireBoolean(record, 'downloadComplete', `${path}.downloadComplete`, issues);
      requireRecordArray(record, 'downloadProgressSamples', `${path}.downloadProgressSamples`, issues);
      break;
    case 'prompt-non-streaming':
      requireBoolean(record, 'success', `${path}.success`, issues);
      requireNonNegativeNumber(record, 'sessionCreateMs', `${path}.sessionCreateMs`, issues);
      requireNonNegativeNumber(record, 'timeToFirstTokenMs', `${path}.timeToFirstTokenMs`, issues);
      requireNonNegativeNumber(record, 'totalTokens', `${path}.totalTokens`, issues);
      requireNonNegativeNumber(record, 'tokensPerSec', `${path}.tokensPerSec`, issues);
      requireStringField(record, 'promptLanguage', `${path}.promptLanguage`, issues);
      requireStringField(record, 'outputLanguage', `${path}.outputLanguage`, issues);
      optionalEnum(record, 'errorCategory', ERROR_CATEGORIES, `${path}.errorCategory`, issues);
      break;
    case 'prompt-streaming':
      requireBoolean(record, 'success', `${path}.success`, issues);
      requireNonNegativeNumber(record, 'sessionCreateMs', `${path}.sessionCreateMs`, issues);
      requireNonNegativeNumber(record, 'timeToFirstChunkMs', `${path}.timeToFirstChunkMs`, issues);
      requireNonNegativeNumber(record, 'timeToFirstTokenMs', `${path}.timeToFirstTokenMs`, issues);
      requireNonNegativeNumber(record, 'totalTokens', `${path}.totalTokens`, issues);
      requireNonNegativeNumber(record, 'tokensPerSec', `${path}.tokensPerSec`, issues);
      requireNonNegativeNumber(record, 'chunkCount', `${path}.chunkCount`, issues);
      requireStringField(record, 'promptLanguage', `${path}.promptLanguage`, issues);
      requireStringField(record, 'outputLanguage', `${path}.outputLanguage`, issues);
      optionalEnum(record, 'errorCategory', ERROR_CATEGORIES, `${path}.errorCategory`, issues);
      break;
    case 'expected-inputs-outputs':
      requireBoolean(record, 'expectedInputsAccepted', `${path}.expectedInputsAccepted`, issues);
      requireBoolean(record, 'expectedOutputsAccepted', `${path}.expectedOutputsAccepted`, issues);
      requireBoolean(record, 'japaneseInputAccepted', `${path}.japaneseInputAccepted`, issues);
      requireBoolean(record, 'japaneseOutputProduced', `${path}.japaneseOutputProduced`, issues);
      requireStringField(record, 'promptLanguage', `${path}.promptLanguage`, issues);
      requireStringField(record, 'outputLanguage', `${path}.outputLanguage`, issues);
      break;
    case 'abort-interruption':
      requireBoolean(record, 'abortSupported', `${path}.abortSupported`, issues);
      requireEnum(record, 'abortOrErrorCategory', ERROR_CATEGORIES, `${path}.abortOrErrorCategory`, issues);
      requireNonNegativeNumber(record, 'timeToAbortMs', `${path}.timeToAbortMs`, issues);
      requireBoolean(record, 'outputTruncated', `${path}.outputTruncated`, issues);
      break;
    case 'context-usage-and-overflow':
      validateContextUsage(scenario.contextUsage, `${path}.contextUsage`, issues);
      validateContextWindow(scenario.contextWindow, `${path}.contextWindow`, issues);
      requireBoolean(record, 'contextOverflowObserved', `${path}.contextOverflowObserved`, issues);
      requireBoolean(record, 'quotaErrorObserved', `${path}.quotaErrorObserved`, issues);
      requireEnum(record, 'abortOrErrorCategory', ERROR_CATEGORIES, `${path}.abortOrErrorCategory`, issues);
      break;
    case 'session-destroy-recreate':
      requireBoolean(record, 'destroySucceeded', `${path}.destroySucceeded`, issues);
      requireBoolean(record, 'recreateSucceeded', `${path}.recreateSucceeded`, issues);
      requireNonNegativeNumber(record, 'destroyRecreateMs', `${path}.destroyRecreateMs`, issues);
      break;
    case 'concurrent-sessions':
      requireNonNegativeNumber(record, 'sessionCount', `${path}.sessionCount`, issues);
      requireNonNegativeNumber(record, 'executionCount', `${path}.executionCount`, issues);
      requireBoolean(record, 'maxConcurrentSupported', `${path}.maxConcurrentSupported`, issues);
      requireNonNegativeNumber(record, 'concurrentSessionErrors', `${path}.concurrentSessionErrors`, issues);
      break;
    case 'surface-matrix':
      validateSurfaceEntries(scenario.surfaces, `${path}.surfaces`, issues);
      break;
  }
}

function validateContextUsage(
  input: unknown,
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  if (!isRecord(input)) {
    issue(issues, 'invalid-context-usage', path, 'contextUsage must be an object');
    return;
  }
  requireNonNegativeNumber(input, 'usedTokens', `${path}.usedTokens`, issues);
  requireNonNegativeNumber(input, 'totalTokens', `${path}.totalTokens`, issues);
  requireNonNegativeNumber(input, 'ratio', `${path}.ratio`, issues);
}

function validateContextWindow(
  input: unknown,
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  if (!isRecord(input)) {
    issue(issues, 'invalid-context-window', path, 'contextWindow must be an object');
    return;
  }
  requireNonNegativeNumber(input, 'min', `${path}.min`, issues);
  requireNonNegativeNumber(input, 'max', `${path}.max`, issues);
}

function validateSurfaceEntries(
  input: unknown,
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  if (!Array.isArray(input) || input.length === 0) {
    issue(issues, 'invalid-surface-matrix', path, 'surfaces must be a non-empty array');
    return;
  }
  input.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issue(issues, 'invalid-surface-entry', entryPath, 'surface entry must be an object');
      return;
    }
    requireEnum(entry, 'surface', SURFACES, `${entryPath}.surface`, issues);
    requireBoolean(entry, 'tested', `${entryPath}.tested`, issues);
    requireBoolean(entry, 'available', `${entryPath}.available`, issues);
    requireBoolean(entry, 'usable', `${entryPath}.usable`, issues);
    requireBoolean(entry, 'createAllowed', `${entryPath}.createAllowed`, issues);
    optionalEnum(entry, 'errorCategory', ERROR_CATEGORIES, `${entryPath}.errorCategory`, issues);
  });
}

// --- field helpers ---------------------------------------------------------------

function requireStringField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  if (!isNonEmptyString(record[key])) {
    issue(issues, 'invalid-string-field', path, `${key} must be a non-empty string`);
  }
}

function requireNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  if (!isNonNegativeFiniteNumber(record[key])) {
    issue(issues, 'invalid-number-field', path, `${key} must be a non-negative finite number`);
  }
}

function optionalNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  if (record[key] !== undefined && !isNonNegativeFiniteNumber(record[key])) {
    issue(issues, 'invalid-number-field', path, `${key} must be a non-negative finite number`);
  }
}

function requireBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  if (typeof record[key] !== 'boolean') {
    issue(issues, 'invalid-boolean-field', path, `${key} must be a boolean`);
  }
}

function requireEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  if (typeof record[key] !== 'string' || !allowed.includes(record[key] as string)) {
    issue(issues, 'invalid-enum-field', path, `${key} must be one of: ${allowed.join(', ')}`);
  }
}

function optionalEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  if (record[key] !== undefined &&
      (typeof record[key] !== 'string' || !allowed.includes(record[key] as string))) {
    issue(issues, 'invalid-enum-field', path, `${key} must be one of: ${allowed.join(', ')}`);
  }
}

function requireStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  if (!Array.isArray(record[key]) ||
      !(record[key] as unknown[]).every((value) => typeof value === 'string')) {
    issue(issues, 'invalid-array-field', path, `${key} must be an array of strings`);
  }
}

function requireRecordArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ChromePromptApiValidationIssue[],
): void {
  if (!Array.isArray(record[key]) ||
      !(record[key] as unknown[]).every((value) => isRecord(value))) {
    issue(issues, 'invalid-array-field', path, `${key} must be an array of objects`);
  }
}

// --- provenance / readiness --------------------------------------------------------

/**
 * Derive the report readiness label. Only a 'captured-and-verified' envelope
 * that fully validates (artifact loader + independent verifier supplied by the
 * caller) yields 'real-browser-verified'. Everything else stays synthetic,
 * self-reported, or not-evaluated, so hand-written fields cannot fabricate a
 * verified claim.
 */
function deriveReadiness(
  evidenceValidation: EvidenceValidationResult | undefined,
  hasEvidence: boolean,
): ChromePromptApiReadiness {
  if (!hasEvidence || evidenceValidation === undefined) {
    return 'self-reported';
  }
  if (evidenceValidation.status !== 'valid') {
    return 'not-evaluated';
  }
  switch (evidenceValidation.effectiveEvidenceLevel) {
    case 'captured-and-verified':
      return 'real-browser-verified';
    case 'synthetic-fixture':
      return 'synthetic';
    default:
      return 'self-reported';
  }
}

function conditionForScenario(
  verified: boolean,
  report: ChromePromptApiFeasibilityReport | undefined,
  entry: { readonly name: string; readonly scenario: ChromePromptApiScenarioName },
): ChromePromptApiDecisionCondition {
  const record = report?.scenarios.find((candidate) => candidate.scenario === entry.scenario);
  if (!verified || record === undefined) {
    // Self-reported scenario results must never read as 'met' while the whole
    // report is unverified: every condition stays pending (未解決条件) until a
    // captured-and-verified envelope backs the run.
    return {
      name: entry.name,
      status: 'pending',
      reason: record === undefined
        ? `scenario '${entry.scenario}' not recorded; requires real-browser measurement`
        : `scenario '${entry.scenario}' is self-reported; requires real-browser measurement`,
    };
  }
  switch (record.scenarioStatus) {
    case 'pass':
      return { name: entry.name, status: 'met', reason: `scenario '${entry.scenario}' passed` };
    case 'fail':
      return { name: entry.name, status: 'failed', reason: `scenario '${entry.scenario}' failed` };
    default:
      return {
        name: entry.name,
        status: 'pending',
        reason: `scenario '${entry.scenario}' not applicable; requires real-browser measurement`,
      };
  }
}

// --- primitives ---------------------------------------------------------------------

function issue(
  issues: ChromePromptApiValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
