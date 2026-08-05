/**
 * Runtime validator for `WorkerCapability` (issue #94 deliverable 2, 6).
 *
 * A capability crosses a trust boundary (worker → Coordinator), so it is never
 * trusted silently. Validation enforces:
 *
 *   - the capability schema version is supported, otherwise the registration
 *     is rejected (`unsupported-schema-version`);
 *   - every field is structurally sound (enums, ranges, consistency);
 *   - unknown top-level fields are REJECTED by default. The caller may opt
 *     into `unknownFieldPolicy: 'ignore'`, but even then the field is ignored
 *     explicitly and never used for routing decisions.
 */
import {
  CAPABILITY_SCHEMA_VERSION,
  INFERENCE_BACKEND_KINDS,
  isInferenceBackendKind,
  type ExecutionMode,
  type ExecutionSurface,
  type InputModality,
  type ModelDownloadState,
  type NetworkDestination,
  type OutputModality,
  type PrivacyBoundary,
  type WorkerCapability,
} from './inference-backend.js';
import { classifyErrorCode } from './errors.js';

export type CapabilityValidationStatus = 'valid' | 'invalid';

export type CapabilityValidationIssueCode =
  | 'invalid-capability'
  | 'unsupported-schema-version'
  | 'invalid-backend'
  | 'invalid-runtime'
  | 'invalid-execution-mode'
  | 'invalid-modalities'
  | 'invalid-languages'
  | 'invalid-streaming'
  | 'invalid-context-window'
  | 'invalid-download-state'
  | 'invalid-user-activation'
  | 'invalid-execution-surfaces'
  | 'invalid-cancellation'
  | 'invalid-max-concurrency'
  | 'invalid-latency'
  | 'invalid-health'
  | 'invalid-privacy-boundary'
  | 'invalid-network-destinations'
  | 'unknown-field';

export interface CapabilityValidationIssue {
  readonly code: CapabilityValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface CapabilityValidationResult {
  readonly status: CapabilityValidationStatus;
  readonly issues: readonly CapabilityValidationIssue[];
}

export interface CapabilityValidationOptions {
  readonly supportedSchemaVersions?: readonly string[];
  /**
   * How to treat unknown top-level fields. Default `'reject'`; a caller that
   * explicitly tolerates forward-compatible additions may pass `'ignore'`.
   */
  readonly unknownFieldPolicy?: 'reject' | 'ignore';
}

const EXECUTION_MODES: readonly ExecutionMode[] = ['segment', 'full-model'];
const INPUT_MODALITIES: readonly InputModality[] = ['text', 'image', 'audio'];
const OUTPUT_MODALITIES: readonly OutputModality[] = ['text', 'token-stream', 'image', 'audio'];
const DOWNLOAD_STATES: readonly ModelDownloadState[] = [
  'unavailable',
  'downloadable',
  'downloading',
  'available',
];
const EXECUTION_SURFACES: readonly ExecutionSurface[] = ['document', 'worker'];
const PRIVACY_BOUNDARIES: readonly PrivacyBoundary[] = ['in-browser', 'server'];
const NETWORK_DESTINATIONS: readonly NetworkDestination[] = [
  'coordinator',
  'cdn',
  'server',
  'none',
];

/** Top-level fields this schema understands (drives unknown-field handling). */
const KNOWN_CAPABILITY_FIELDS = new Set([
  'schemaVersion',
  'backend',
  'runtimeName',
  'runtimeVersion',
  'executionMode',
  'inputModalities',
  'outputModalities',
  'supportedLanguages',
  'streaming',
  'contextWindowTokens',
  'currentContextUsageTokens',
  'modelDownloadState',
  'requiresUserActivation',
  'executionSurfaces',
  'supportsCancellation',
  'maxConcurrency',
  'expectedLatencyMs',
  'health',
  'privacyBoundary',
  'allowedNetworkDestinations',
]);

/**
 * Validate an unknown value as a `WorkerCapability`. Returns issues instead of
 * throwing so the Coordinator can surface a structured rejection reason.
 */
export function validateWorkerCapability(
  input: unknown,
  options: CapabilityValidationOptions = {},
): CapabilityValidationResult {
  const issues: CapabilityValidationIssue[] = [];
  if (!isRecord(input)) {
    issue(issues, 'invalid-capability', '$', 'worker capability must be an object');
    return { status: 'invalid', issues };
  }

  const capability = input as Record<string, unknown>;

  // Unknown top-level fields are rejected by default; a caller that explicitly
  // tolerates forward-compatible additions opts into 'ignore'. Either way an
  // unknown field is never used for routing decisions.
  if (options.unknownFieldPolicy !== 'ignore') {
    for (const key of Object.keys(capability)) {
      if (!KNOWN_CAPABILITY_FIELDS.has(key)) {
        issue(issues, 'unknown-field', `$.${key}`, `unknown capability field '${key}'`);
      }
    }
  }

  const supported = options.supportedSchemaVersions ?? [CAPABILITY_SCHEMA_VERSION];
  if (typeof capability.schemaVersion !== 'string' || capability.schemaVersion.trim().length === 0) {
    issue(issues, 'invalid-capability', '$.schemaVersion', 'schemaVersion must be a non-empty string');
  } else if (!supported.includes(capability.schemaVersion)) {
    issue(
      issues,
      'unsupported-schema-version',
      '$.schemaVersion',
      `unsupported capability schema version: ${capability.schemaVersion}`,
    );
  }

  if (!isInferenceBackendKind(capability.backend)) {
    issue(
      issues,
      'invalid-backend',
      '$.backend',
      `backend must be one of ${INFERENCE_BACKEND_KINDS.join(', ')}`,
    );
  }

  requiredNonEmptyString(capability, 'runtimeName', '$.runtimeName', issues, 'invalid-runtime');
  requiredNonEmptyString(
    capability,
    'runtimeVersion',
    '$.runtimeVersion',
    issues,
    'invalid-runtime',
  );

  if (
    typeof capability.executionMode !== 'string' ||
    !EXECUTION_MODES.includes(capability.executionMode as ExecutionMode)
  ) {
    issue(
      issues,
      'invalid-execution-mode',
      '$.executionMode',
      "executionMode must be 'segment' or 'full-model'",
    );
  }

  validateModalities(capability.inputModalities, '$.inputModalities', INPUT_MODALITIES, issues);
  validateModalities(capability.outputModalities, '$.outputModalities', OUTPUT_MODALITIES, issues);

  if (
    !Array.isArray(capability.supportedLanguages) ||
    capability.supportedLanguages.length === 0 ||
    !capability.supportedLanguages.every(
      (value) => typeof value === 'string' && value.trim().length > 0,
    )
  ) {
    issue(
      issues,
      'invalid-languages',
      '$.supportedLanguages',
      'supportedLanguages must be a non-empty array of language tags',
    );
  }

  if (typeof capability.streaming !== 'boolean') {
    issue(issues, 'invalid-streaming', '$.streaming', 'streaming must be a boolean');
  }

  const contextWindow = capability.contextWindowTokens;
  if (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0) {
    issue(
      issues,
      'invalid-context-window',
      '$.contextWindowTokens',
      'contextWindowTokens must be a positive integer',
    );
  }
  const usage = capability.currentContextUsageTokens;
  if (usage !== undefined) {
    if (typeof usage !== 'number' || !Number.isInteger(usage) || usage < 0) {
      issue(
        issues,
        'invalid-context-window',
        '$.currentContextUsageTokens',
        'currentContextUsageTokens must be a non-negative integer',
      );
    } else if (typeof contextWindow === 'number' && usage > contextWindow) {
      issue(
        issues,
        'invalid-context-window',
        '$.currentContextUsageTokens',
        `currentContextUsageTokens ${usage} exceeds contextWindowTokens ${contextWindow}`,
      );
    }
  }

  const downloadState = capability.modelDownloadState;
  if (downloadState !== undefined) {
    if (
      typeof downloadState !== 'string' ||
      !DOWNLOAD_STATES.includes(downloadState as ModelDownloadState)
    ) {
      issue(
        issues,
        'invalid-download-state',
        '$.modelDownloadState',
        "modelDownloadState must be one of 'unavailable' | 'downloadable' | 'downloading' | 'available'",
      );
    }
  }

  if (typeof capability.requiresUserActivation !== 'boolean') {
    issue(
      issues,
      'invalid-user-activation',
      '$.requiresUserActivation',
      'requiresUserActivation must be a boolean',
    );
  }

  validateEnumArray(
    capability.executionSurfaces,
    '$.executionSurfaces',
    EXECUTION_SURFACES,
    'invalid-execution-surfaces',
    issues,
  );

  if (typeof capability.supportsCancellation !== 'boolean') {
    issue(
      issues,
      'invalid-cancellation',
      '$.supportsCancellation',
      'supportsCancellation must be a boolean',
    );
  }

  if (
    typeof capability.maxConcurrency !== 'number' ||
    !Number.isInteger(capability.maxConcurrency) ||
    capability.maxConcurrency <= 0
  ) {
    issue(
      issues,
      'invalid-max-concurrency',
      '$.maxConcurrency',
      'maxConcurrency must be a positive integer',
    );
  }

  if (
    typeof capability.expectedLatencyMs !== 'number' ||
    !Number.isFinite(capability.expectedLatencyMs) ||
    capability.expectedLatencyMs < 0
  ) {
    issue(
      issues,
      'invalid-latency',
      '$.expectedLatencyMs',
      'expectedLatencyMs must be a non-negative number',
    );
  }

  validateHealth(capability.health, issues);

  if (
    typeof capability.privacyBoundary !== 'string' ||
    !PRIVACY_BOUNDARIES.includes(capability.privacyBoundary as PrivacyBoundary)
  ) {
    issue(
      issues,
      'invalid-privacy-boundary',
      '$.privacyBoundary',
      "privacyBoundary must be 'in-browser' or 'server'",
    );
  }

  validateEnumArray(
    capability.allowedNetworkDestinations,
    '$.allowedNetworkDestinations',
    NETWORK_DESTINATIONS,
    'invalid-network-destinations',
    issues,
  );

  if (issues.length > 0) {
    return { status: 'invalid', issues };
  }
  return { status: 'valid', issues };
}

/**
 * Fail-fast helper: throws when a capability is invalid. Used at backend
 * registration so an invalid capability can never enter the routing table.
 */
export function assertValidWorkerCapability(
  capability: WorkerCapability,
  options: CapabilityValidationOptions = {},
): WorkerCapability {
  const validation = validateWorkerCapability(capability, options);
  if (validation.status !== 'valid') {
    const detail = validation.issues
      .map((item) => `${item.path} ${item.code}: ${item.message}`)
      .join('; ');
    throw new Error(`worker capability validation failed: ${detail}`);
  }
  return capability;
}

function validateModalities(
  value: unknown,
  path: string,
  allowed: readonly string[],
  issues: CapabilityValidationIssue[],
): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === 'string' && allowed.includes(item))
  ) {
    issue(
      issues,
      'invalid-modalities',
      path,
      `${path} must be a non-empty array of ${allowed.join(', ')}`,
    );
  }
}

function validateEnumArray(
  value: unknown,
  path: string,
  allowed: readonly string[],
  code: CapabilityValidationIssueCode,
  issues: CapabilityValidationIssue[],
): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === 'string' && allowed.includes(item))
  ) {
    issue(issues, code, path, `${path} must be a non-empty array of ${allowed.join(', ')}`);
  }
}

function validateHealth(
  value: unknown,
  issues: CapabilityValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issue(issues, 'invalid-health', '$.health', 'health must be an object');
    return;
  }
  const rate = value.recentFailureRate;
  if (
    typeof rate !== 'number' ||
    !Number.isFinite(rate) ||
    rate < 0 ||
    rate > 1
  ) {
    issue(
      issues,
      'invalid-health',
      '$.health.recentFailureRate',
      'recentFailureRate must be a number in [0,1]',
    );
  }
  const lastCode = value.lastErrorCode;
  if (lastCode !== undefined) {
    if (typeof lastCode !== 'string' || classifyErrorCode(lastCode) === undefined) {
      issue(
        issues,
        'invalid-health',
        '$.health.lastErrorCode',
        `lastErrorCode must be a structured ErrorCode, got '${String(lastCode)}'`,
      );
    }
  }
}

function requiredNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: CapabilityValidationIssue[],
  code: CapabilityValidationIssueCode,
): void {
  if (typeof record[key] !== 'string' || record[key].trim().length === 0) {
    issue(issues, code, path, `${key} must be a non-empty string`);
  }
}

function issue(
  issues: CapabilityValidationIssue[],
  code: CapabilityValidationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
