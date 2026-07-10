export const EVIDENCE_SCHEMA_VERSION = '1.0.0' as const;

export type EvidenceLevel =
  | 'synthetic-fixture'
  | 'self-reported-runtime'
  | 'captured-and-verified';

export type ReadinessStatus =
  | 'design-only'
  | 'contract-tested'
  | 'runtime-observed'
  | 'verified-pilot'
  | 'production-candidate'
  | 'production-approved';

export interface EvidenceProducer {
  name: string;
  version: string;
  commitSha?: string;
}

export interface EvidenceBrowserEnvironment {
  name: string;
  version: string;
}

export interface EvidenceOperatingSystem {
  name: string;
  version: string;
}

export interface EvidenceEnvironment {
  runtime: string;
  runtimeVersion: string;
  executionSurface: string;
  os?: EvidenceOperatingSystem;
  browser?: EvidenceBrowserEnvironment;
  metadata?: Record<string, string>;
}

export interface EvidenceArtifact {
  locator: string;
  sha256: string;
  expiresAt: string;
}

export interface EvidenceVerification {
  verifier: string;
  version: string;
  verifiedAt: string;
  result: 'pass' | 'fail';
}

export interface EvidenceRedaction {
  applied: boolean;
  policyVersion: string;
}

export interface EvidenceScenario {
  feature: string;
  scenario: string;
  expectedResult: string;
}

interface EvidenceEnvelopeBase<TPayload> {
  schemaVersion: string;
  evidenceKind: string;
  evidenceLevel: EvidenceLevel;
  readinessStatus: ReadinessStatus;
  producer: EvidenceProducer;
  runId: string;
  capturedAt: string;
  environment: EvidenceEnvironment;
  redaction: EvidenceRedaction;
  scenario?: EvidenceScenario;
  payload: TPayload;
}

export interface SyntheticEvidenceEnvelope<TPayload = unknown>
  extends EvidenceEnvelopeBase<TPayload> {
  evidenceLevel: 'synthetic-fixture';
  readinessStatus: 'design-only' | 'contract-tested';
  artifact?: never;
  verification?: never;
}

export interface SelfReportedEvidenceEnvelope<TPayload = unknown>
  extends EvidenceEnvelopeBase<TPayload> {
  evidenceLevel: 'self-reported-runtime';
  readinessStatus: 'design-only' | 'contract-tested' | 'runtime-observed';
  artifact?: Omit<EvidenceArtifact, 'expiresAt'> & { expiresAt?: string };
  verification?: never;
}

export interface CapturedAndVerifiedEvidenceEnvelope<TPayload = unknown>
  extends EvidenceEnvelopeBase<TPayload> {
  evidenceLevel: 'captured-and-verified';
  readinessStatus: ReadinessStatus;
  producer: EvidenceProducer & { commitSha: string };
  environment: EvidenceEnvironment & { os: EvidenceOperatingSystem };
  scenario: EvidenceScenario;
  artifact: EvidenceArtifact;
  verification: EvidenceVerification;
}

export type EvidenceEnvelope<TPayload = unknown> =
  | SyntheticEvidenceEnvelope<TPayload>
  | SelfReportedEvidenceEnvelope<TPayload>
  | CapturedAndVerifiedEvidenceEnvelope<TPayload>;

export type ArtifactContent = string | ArrayBuffer | Uint8Array;

export interface TrustedEvidenceVerifier {
  name: string;
  version?: string;
}

export interface EvidenceValidationOptions {
  now?: Date | string | number;
  supportedSchemaVersions?: readonly string[];
  trustedVerifiers?: readonly TrustedEvidenceVerifier[];
  loadArtifact?: (locator: string) => Promise<ArtifactContent>;
}

export type EvidenceValidationStatus = 'valid' | 'invalid' | 'not-evaluated';

export type EvidenceValidationIssueCode =
  | 'invalid-envelope'
  | 'unsupported-schema-version'
  | 'invalid-evidence-level'
  | 'invalid-readiness-status'
  | 'readiness-exceeds-evidence-level'
  | 'invalid-timestamp'
  | 'future-captured-at'
  | 'missing-producer-commit-sha'
  | 'missing-environment-metadata'
  | 'missing-browser-metadata'
  | 'missing-scenario-metadata'
  | 'missing-artifact'
  | 'invalid-artifact-digest'
  | 'expired-artifact'
  | 'missing-verification'
  | 'verification-failed'
  | 'verification-before-capture'
  | 'untrusted-verifier'
  | 'artifact-unavailable'
  | 'artifact-load-failed'
  | 'artifact-digest-mismatch';

export interface EvidenceValidationIssue {
  code: EvidenceValidationIssueCode;
  path: string;
  message: string;
}

export interface EvidenceValidationResult<TPayload = unknown> {
  status: EvidenceValidationStatus;
  claimedEvidenceLevel?: EvidenceLevel;
  effectiveEvidenceLevel?: EvidenceLevel;
  claimedReadinessStatus?: ReadinessStatus;
  effectiveReadinessStatus?: ReadinessStatus;
  issues: EvidenceValidationIssue[];
  envelope?: EvidenceEnvelope<TPayload>;
}

const EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  'synthetic-fixture',
  'self-reported-runtime',
  'captured-and-verified',
];

const READINESS_STATUSES: readonly ReadinessStatus[] = [
  'design-only',
  'contract-tested',
  'runtime-observed',
  'verified-pilot',
  'production-candidate',
  'production-approved',
];

const READINESS_RANK: Record<ReadinessStatus, number> = {
  'design-only': 0,
  'contract-tested': 1,
  'runtime-observed': 2,
  'verified-pilot': 3,
  'production-candidate': 4,
  'production-approved': 5,
};

const MAX_READINESS_BY_EVIDENCE_LEVEL: Record<EvidenceLevel, ReadinessStatus> = {
  'synthetic-fixture': 'contract-tested',
  'self-reported-runtime': 'runtime-observed',
  'captured-and-verified': 'production-approved',
};

const SHA256_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/i;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export async function validateEvidenceEnvelope<TPayload = unknown>(
  input: unknown,
  options: EvidenceValidationOptions = {},
): Promise<EvidenceValidationResult<TPayload>> {
  const issues: EvidenceValidationIssue[] = [];

  if (!isRecord(input)) {
    addIssue(issues, 'invalid-envelope', '$', 'evidence envelope must be an object');
    return { status: 'invalid', issues };
  }

  const claimedEvidenceLevel = isEvidenceLevel(input.evidenceLevel)
    ? input.evidenceLevel
    : undefined;
  const claimedReadinessStatus = isReadinessStatus(input.readinessStatus)
    ? input.readinessStatus
    : undefined;

  validateBaseEnvelope(input, issues);

  if (!claimedEvidenceLevel) {
    addIssue(
      issues,
      'invalid-evidence-level',
      '$.evidenceLevel',
      `evidenceLevel must be one of: ${EVIDENCE_LEVELS.join(', ')}`,
    );
  }

  if (!claimedReadinessStatus) {
    addIssue(
      issues,
      'invalid-readiness-status',
      '$.readinessStatus',
      `readinessStatus must be one of: ${READINESS_STATUSES.join(', ')}`,
    );
  }

  const supportedSchemaVersions = options.supportedSchemaVersions ?? [EVIDENCE_SCHEMA_VERSION];
  if (
    typeof input.schemaVersion === 'string' &&
    !supportedSchemaVersions.includes(input.schemaVersion)
  ) {
    addIssue(
      issues,
      'unsupported-schema-version',
      '$.schemaVersion',
      `unsupported evidence schema version: ${input.schemaVersion}`,
    );
  }

  if (claimedEvidenceLevel && claimedReadinessStatus) {
    const maximumReadiness = MAX_READINESS_BY_EVIDENCE_LEVEL[claimedEvidenceLevel];
    if (READINESS_RANK[claimedReadinessStatus] > READINESS_RANK[maximumReadiness]) {
      addIssue(
        issues,
        'readiness-exceeds-evidence-level',
        '$.readinessStatus',
        `${claimedEvidenceLevel} evidence cannot claim ${claimedReadinessStatus}; maximum is ${maximumReadiness}`,
      );
    }
  }

  const nowMs = resolveNowMs(options.now);
  const capturedAtMs = parseTimestamp(input.capturedAt);
  if (capturedAtMs !== undefined && capturedAtMs > nowMs + MAX_CLOCK_SKEW_MS) {
    addIssue(
      issues,
      'future-captured-at',
      '$.capturedAt',
      'capturedAt is later than the allowed clock skew',
    );
  }

  if (claimedEvidenceLevel === 'captured-and-verified') {
    validateCapturedAndVerifiedShape(input, issues, nowMs, capturedAtMs, options);
  }

  if (issues.length > 0) {
    return {
      status: issues.some((issue) => issue.code === 'artifact-unavailable')
        ? 'not-evaluated'
        : 'invalid',
      claimedEvidenceLevel,
      claimedReadinessStatus,
      issues,
    };
  }

  const envelope = input as unknown as EvidenceEnvelope<TPayload>;

  if (claimedEvidenceLevel !== 'captured-and-verified') {
    return {
      status: 'valid',
      claimedEvidenceLevel,
      effectiveEvidenceLevel: claimedEvidenceLevel,
      claimedReadinessStatus,
      effectiveReadinessStatus: claimedReadinessStatus,
      issues,
      envelope,
    };
  }

  const capturedEnvelope = envelope as CapturedAndVerifiedEvidenceEnvelope<TPayload>;
  if (!options.loadArtifact) {
    addIssue(
      issues,
      'artifact-unavailable',
      '$.artifact.locator',
      'captured-and-verified evidence requires an external artifact loader',
    );
    return {
      status: 'not-evaluated',
      claimedEvidenceLevel,
      claimedReadinessStatus,
      issues,
    };
  }

  let artifactContent: ArtifactContent;
  try {
    artifactContent = await options.loadArtifact(capturedEnvelope.artifact.locator);
  } catch (error) {
    addIssue(
      issues,
      'artifact-load-failed',
      '$.artifact.locator',
      `artifact could not be loaded: ${formatError(error)}`,
    );
    return {
      status: 'not-evaluated',
      claimedEvidenceLevel,
      claimedReadinessStatus,
      issues,
    };
  }

  const actualDigest = await sha256Hex(artifactContent);
  const expectedDigest = normalizeSha256(capturedEnvelope.artifact.sha256);
  if (actualDigest !== expectedDigest) {
    addIssue(
      issues,
      'artifact-digest-mismatch',
      '$.artifact.sha256',
      `artifact digest mismatch: expected ${expectedDigest}, got ${actualDigest}`,
    );
    return {
      status: 'invalid',
      claimedEvidenceLevel,
      claimedReadinessStatus,
      issues,
    };
  }

  return {
    status: 'valid',
    claimedEvidenceLevel,
    effectiveEvidenceLevel: 'captured-and-verified',
    claimedReadinessStatus,
    effectiveReadinessStatus: claimedReadinessStatus,
    issues,
    envelope,
  };
}

export function evidenceSupportsReadiness(
  result: EvidenceValidationResult,
  minimumReadiness: ReadinessStatus = 'production-candidate',
): boolean {
  return (
    result.status === 'valid' &&
    result.effectiveEvidenceLevel === 'captured-and-verified' &&
    result.effectiveReadinessStatus !== undefined &&
    READINESS_RANK[result.effectiveReadinessStatus] >= READINESS_RANK[minimumReadiness]
  );
}

function validateBaseEnvelope(
  input: Record<string, unknown>,
  issues: EvidenceValidationIssue[],
): void {
  requireNonEmptyString(input, 'schemaVersion', '$.schemaVersion', issues);
  requireNonEmptyString(input, 'evidenceKind', '$.evidenceKind', issues);
  requireNonEmptyString(input, 'runId', '$.runId', issues);
  requireTimestamp(input, 'capturedAt', '$.capturedAt', issues);

  if (!isRecord(input.producer)) {
    addIssue(issues, 'invalid-envelope', '$.producer', 'producer must be an object');
  } else {
    requireNonEmptyString(input.producer, 'name', '$.producer.name', issues);
    requireNonEmptyString(input.producer, 'version', '$.producer.version', issues);
  }

  if (!isRecord(input.environment)) {
    addIssue(issues, 'invalid-envelope', '$.environment', 'environment must be an object');
  } else {
    requireNonEmptyString(input.environment, 'runtime', '$.environment.runtime', issues);
    requireNonEmptyString(
      input.environment,
      'runtimeVersion',
      '$.environment.runtimeVersion',
      issues,
    );
    requireNonEmptyString(
      input.environment,
      'executionSurface',
      '$.environment.executionSurface',
      issues,
    );
  }

  if (!isRecord(input.redaction)) {
    addIssue(issues, 'invalid-envelope', '$.redaction', 'redaction must be an object');
  } else {
    if (typeof input.redaction.applied !== 'boolean') {
      addIssue(
        issues,
        'invalid-envelope',
        '$.redaction.applied',
        'redaction.applied must be a boolean',
      );
    }
    requireNonEmptyString(
      input.redaction,
      'policyVersion',
      '$.redaction.policyVersion',
      issues,
    );
  }

  if (!Object.prototype.hasOwnProperty.call(input, 'payload')) {
    addIssue(issues, 'invalid-envelope', '$.payload', 'payload is required');
  }
}

function validateCapturedAndVerifiedShape(
  input: Record<string, unknown>,
  issues: EvidenceValidationIssue[],
  nowMs: number,
  capturedAtMs: number | undefined,
  options: EvidenceValidationOptions,
): void {
  if (!isRecord(input.producer) || !isNonEmptyString(input.producer.commitSha)) {
    addIssue(
      issues,
      'missing-producer-commit-sha',
      '$.producer.commitSha',
      'captured-and-verified evidence requires producer.commitSha',
    );
  }

  if (!isRecord(input.environment)) {
    addIssue(
      issues,
      'missing-environment-metadata',
      '$.environment',
      'captured-and-verified evidence requires environment metadata',
    );
  } else {
    if (
      !isRecord(input.environment.os) ||
      !isNonEmptyString(input.environment.os.name) ||
      !isNonEmptyString(input.environment.os.version)
    ) {
      addIssue(
        issues,
        'missing-environment-metadata',
        '$.environment.os',
        'captured-and-verified evidence requires OS name and version',
      );
    }

    if (
      isBrowserExecutionSurface(input.environment.executionSurface) &&
      (!isRecord(input.environment.browser) ||
        !isNonEmptyString(input.environment.browser.name) ||
        !isNonEmptyString(input.environment.browser.version))
    ) {
      addIssue(
        issues,
        'missing-browser-metadata',
        '$.environment.browser',
        'browser execution evidence requires browser name and version',
      );
    }
  }

  if (
    !isRecord(input.scenario) ||
    !isNonEmptyString(input.scenario.feature) ||
    !isNonEmptyString(input.scenario.scenario) ||
    !isNonEmptyString(input.scenario.expectedResult)
  ) {
    addIssue(
      issues,
      'missing-scenario-metadata',
      '$.scenario',
      'captured-and-verified evidence requires feature, scenario, and expectedResult',
    );
  }

  if (!isRecord(input.artifact)) {
    addIssue(
      issues,
      'missing-artifact',
      '$.artifact',
      'captured-and-verified evidence requires an artifact',
    );
  } else {
    requireNonEmptyString(input.artifact, 'locator', '$.artifact.locator', issues);

    if (!isNonEmptyString(input.artifact.sha256) || !SHA256_PATTERN.test(input.artifact.sha256)) {
      addIssue(
        issues,
        'invalid-artifact-digest',
        '$.artifact.sha256',
        'artifact.sha256 must be a 64-character hexadecimal SHA-256 digest',
      );
    }

    const expiresAtMs = requireTimestamp(
      input.artifact,
      'expiresAt',
      '$.artifact.expiresAt',
      issues,
    );
    if (expiresAtMs !== undefined && expiresAtMs <= nowMs) {
      addIssue(
        issues,
        'expired-artifact',
        '$.artifact.expiresAt',
        'artifact evidence has expired',
      );
    }
  }

  if (!isRecord(input.verification)) {
    addIssue(
      issues,
      'missing-verification',
      '$.verification',
      'captured-and-verified evidence requires verification metadata',
    );
  } else {
    requireNonEmptyString(input.verification, 'verifier', '$.verification.verifier', issues);
    requireNonEmptyString(input.verification, 'version', '$.verification.version', issues);
    const verifiedAtMs = requireTimestamp(
      input.verification,
      'verifiedAt',
      '$.verification.verifiedAt',
      issues,
    );

    if (input.verification.result !== 'pass') {
      addIssue(
        issues,
        'verification-failed',
        '$.verification.result',
        'captured-and-verified evidence requires verification.result=pass',
      );
    }

    if (
      capturedAtMs !== undefined &&
      verifiedAtMs !== undefined &&
      verifiedAtMs < capturedAtMs
    ) {
      addIssue(
        issues,
        'verification-before-capture',
        '$.verification.verifiedAt',
        'verification cannot occur before artifact capture',
      );
    }

    if (
      isNonEmptyString(input.verification.verifier) &&
      isNonEmptyString(input.verification.version) &&
      !isTrustedVerifier(
        input.verification.verifier,
        input.verification.version,
        options.trustedVerifiers ?? [],
      )
    ) {
      addIssue(
        issues,
        'untrusted-verifier',
        '$.verification.verifier',
        `verifier is not trusted: ${input.verification.verifier}@${input.verification.version}`,
      );
    }
  }
}

function isTrustedVerifier(
  name: string,
  version: string,
  trustedVerifiers: readonly TrustedEvidenceVerifier[],
): boolean {
  return trustedVerifiers.some(
    (trusted) => trusted.name === name && (trusted.version === undefined || trusted.version === version),
  );
}

function isBrowserExecutionSurface(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith('browser-') || value.startsWith('extension-'))
  );
}

function resolveNowMs(now: EvidenceValidationOptions['now']): number {
  if (now === undefined) {
    return Date.now();
  }
  if (now instanceof Date) {
    return now.getTime();
  }
  if (typeof now === 'number') {
    return now;
  }
  const parsed = Date.parse(now);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function requireTimestamp(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: EvidenceValidationIssue[],
): number | undefined {
  const value = record[key];
  const parsed = parseTimestamp(value);
  if (parsed === undefined) {
    addIssue(issues, 'invalid-timestamp', path, `${key} must be a valid ISO-8601 timestamp`);
  }
  return parsed;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: EvidenceValidationIssue[],
): void {
  if (!isNonEmptyString(record[key])) {
    addIssue(issues, 'invalid-envelope', path, `${key} must be a non-empty string`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return typeof value === 'string' && EVIDENCE_LEVELS.includes(value as EvidenceLevel);
}

function isReadinessStatus(value: unknown): value is ReadinessStatus {
  return typeof value === 'string' && READINESS_STATUSES.includes(value as ReadinessStatus);
}

function addIssue(
  issues: EvidenceValidationIssue[],
  code: EvidenceValidationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function normalizeSha256(value: string): string {
  return value.toLowerCase().replace(/^sha256:/, '');
}

async function sha256Hex(content: ArtifactContent): Promise<string> {
  const bytes = toUint8Array(content);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toUint8Array(content: ArtifactContent): Uint8Array {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  if (content instanceof Uint8Array) {
    return content;
  }
  return new Uint8Array(content);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
