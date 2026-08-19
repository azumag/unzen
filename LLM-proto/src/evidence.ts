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

export interface EvidenceEnvironment {
  runtime: string;
  runtimeVersion: string;
  executionSurface: string;
  os?: { name: string; version: string };
  browser?: { name: string; version: string };
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
  redaction: { applied: boolean; policyVersion: string };
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
  producer: EvidenceProducer & { commitSha: string };
  environment: EvidenceEnvironment & { os: { name: string; version: string } };
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

export interface IndependentEvidenceVerification {
  verifier: string;
  version: string;
  verifiedAt: string;
  result: 'pass' | 'fail';
  reason?: string;
}

export interface ArtifactVerificationContext<TPayload = unknown> {
  envelope: CapturedAndVerifiedEvidenceEnvelope<TPayload>;
  artifactContent: ArtifactContent;
  actualSha256: string;
}

export interface EvidenceValidationOptions {
  now?: Date | string | number;
  supportedSchemaVersions?: readonly string[];
  trustedVerifiers?: readonly TrustedEvidenceVerifier[];
  loadArtifact?: (locator: string) => Promise<ArtifactContent>;
  verifyArtifact?: (
    context: ArtifactVerificationContext,
  ) => Promise<IndependentEvidenceVerification>;
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
  | 'artifact-digest-mismatch'
  | 'verification-unavailable'
  | 'verification-execution-failed'
  | 'verification-attestation-mismatch';

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
const MAX_READINESS: Record<EvidenceLevel, ReadinessStatus> = {
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
    issue(issues, 'invalid-envelope', '$', 'evidence envelope must be an object');
    return result<TPayload>('invalid', issues);
  }

  const level = isEvidenceLevel(input.evidenceLevel) ? input.evidenceLevel : undefined;
  const readiness = isReadinessStatus(input.readinessStatus)
    ? input.readinessStatus
    : undefined;
  const nowMs = resolveNow(options.now);
  const capturedAtMs = validateBase(input, issues, nowMs);

  if (!level) {
    issue(issues, 'invalid-evidence-level', '$.evidenceLevel', 'invalid evidence level');
  }
  if (!readiness) {
    issue(issues, 'invalid-readiness-status', '$.readinessStatus', 'invalid readiness status');
  }

  const supported = options.supportedSchemaVersions ?? [EVIDENCE_SCHEMA_VERSION];
  if (typeof input.schemaVersion === 'string' && !supported.includes(input.schemaVersion)) {
    issue(
      issues,
      'unsupported-schema-version',
      '$.schemaVersion',
      `unsupported evidence schema version: ${input.schemaVersion}`,
    );
  }

  if (
    level &&
    readiness &&
    READINESS_RANK[readiness] > READINESS_RANK[MAX_READINESS[level]]
  ) {
    issue(
      issues,
      'readiness-exceeds-evidence-level',
      '$.readinessStatus',
      `${level} evidence cannot claim ${readiness}`,
    );
  }

  if (level === 'captured-and-verified') {
    validateCaptured(input, issues, nowMs, capturedAtMs, options.trustedVerifiers ?? []);
  }

  if (issues.length > 0) {
    return result<TPayload>('invalid', issues, level, readiness);
  }

  const envelope = input as unknown as EvidenceEnvelope<TPayload>;
  if (level !== 'captured-and-verified') {
    return {
      status: 'valid',
      claimedEvidenceLevel: level,
      effectiveEvidenceLevel: level,
      claimedReadinessStatus: readiness,
      effectiveReadinessStatus: readiness,
      issues,
      envelope,
    };
  }

  const captured = envelope as CapturedAndVerifiedEvidenceEnvelope<TPayload>;
  if (!options.loadArtifact) {
    issue(
      issues,
      'artifact-unavailable',
      '$.artifact.locator',
      'captured-and-verified evidence requires an external artifact loader',
    );
    return result<TPayload>('not-evaluated', issues, level, readiness);
  }

  let artifactContent: ArtifactContent;
  try {
    artifactContent = await options.loadArtifact(captured.artifact.locator);
  } catch (error) {
    issue(
      issues,
      'artifact-load-failed',
      '$.artifact.locator',
      `artifact could not be loaded: ${formatError(error)}`,
    );
    return result<TPayload>('not-evaluated', issues, level, readiness);
  }

  const actualSha256 = await sha256Hex(artifactContent);
  const expectedSha256 = normalizeSha256(captured.artifact.sha256);
  if (actualSha256 !== expectedSha256) {
    issue(
      issues,
      'artifact-digest-mismatch',
      '$.artifact.sha256',
      `artifact digest mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    );
    return result<TPayload>('invalid', issues, level, readiness);
  }

  if (!options.verifyArtifact) {
    issue(
      issues,
      'verification-unavailable',
      '$.verification',
      'captured-and-verified evidence requires an independent verifier callback',
    );
    return result<TPayload>('not-evaluated', issues, level, readiness);
  }

  let attestation: IndependentEvidenceVerification;
  try {
    attestation = await options.verifyArtifact({
      envelope: captured,
      artifactContent,
      actualSha256,
    });
  } catch (error) {
    issue(
      issues,
      'verification-execution-failed',
      '$.verification',
      `independent verification could not be completed: ${formatError(error)}`,
    );
    return result<TPayload>('not-evaluated', issues, level, readiness);
  }

  if (
    attestation.result !== 'pass' ||
    attestation.verifier !== captured.verification.verifier ||
    attestation.version !== captured.verification.version ||
    attestation.verifiedAt !== captured.verification.verifiedAt
  ) {
    issue(
      issues,
      'verification-attestation-mismatch',
      '$.verification',
      attestation.reason ?? 'independent verifier attestation does not match the envelope',
    );
    return result<TPayload>('invalid', issues, level, readiness);
  }

  if (!isTrustedVerifier(attestation.verifier, attestation.version, options.trustedVerifiers ?? [])) {
    issue(
      issues,
      'untrusted-verifier',
      '$.verification.verifier',
      `verifier is not trusted: ${attestation.verifier}@${attestation.version}`,
    );
    return result<TPayload>('invalid', issues, level, readiness);
  }

  return {
    status: 'valid',
    claimedEvidenceLevel: level,
    effectiveEvidenceLevel: level,
    claimedReadinessStatus: readiness,
    effectiveReadinessStatus: readiness,
    issues,
    envelope,
  };
}

export function evidenceSupportsReadiness(
  validation: EvidenceValidationResult,
  minimum: ReadinessStatus = 'production-candidate',
): boolean {
  return (
    validation.status === 'valid' &&
    validation.effectiveEvidenceLevel === 'captured-and-verified' &&
    validation.effectiveReadinessStatus !== undefined &&
    READINESS_RANK[validation.effectiveReadinessStatus] >= READINESS_RANK[minimum]
  );
}

function validateBase(
  input: Record<string, unknown>,
  issues: EvidenceValidationIssue[],
  nowMs: number,
): number | undefined {
  requiredString(input, 'schemaVersion', '$.schemaVersion', issues);
  requiredString(input, 'evidenceKind', '$.evidenceKind', issues);
  requiredString(input, 'runId', '$.runId', issues);
  const capturedAtMs = requiredTimestamp(input, 'capturedAt', '$.capturedAt', issues);
  if (capturedAtMs !== undefined && capturedAtMs > nowMs + MAX_CLOCK_SKEW_MS) {
    issue(issues, 'future-captured-at', '$.capturedAt', 'capturedAt exceeds clock skew');
  }

  validateNamedVersion(input.producer, '$.producer', issues);
  if (!isRecord(input.environment)) {
    issue(issues, 'invalid-envelope', '$.environment', 'environment must be an object');
  } else {
    requiredString(input.environment, 'runtime', '$.environment.runtime', issues);
    requiredString(input.environment, 'runtimeVersion', '$.environment.runtimeVersion', issues);
    requiredString(
      input.environment,
      'executionSurface',
      '$.environment.executionSurface',
      issues,
    );
  }

  if (!isRecord(input.redaction)) {
    issue(issues, 'invalid-envelope', '$.redaction', 'redaction must be an object');
  } else {
    if (typeof input.redaction.applied !== 'boolean') {
      issue(issues, 'invalid-envelope', '$.redaction.applied', 'applied must be boolean');
    }
    requiredString(input.redaction, 'policyVersion', '$.redaction.policyVersion', issues);
  }

  if (!Object.prototype.hasOwnProperty.call(input, 'payload')) {
    issue(issues, 'invalid-envelope', '$.payload', 'payload is required');
  }
  return capturedAtMs;
}

function validateCaptured(
  input: Record<string, unknown>,
  issues: EvidenceValidationIssue[],
  nowMs: number,
  capturedAtMs: number | undefined,
  trustedVerifiers: readonly TrustedEvidenceVerifier[],
): void {
  if (!isRecord(input.producer) || !isNonEmptyString(input.producer.commitSha)) {
    issue(
      issues,
      'missing-producer-commit-sha',
      '$.producer.commitSha',
      'producer.commitSha is required',
    );
  }

  if (!isRecord(input.environment) || !isNamedVersion(input.environment.os)) {
    issue(
      issues,
      'missing-environment-metadata',
      '$.environment.os',
      'OS name and version are required',
    );
  } else if (
    isBrowserSurface(input.environment.executionSurface) &&
    !isNamedVersion(input.environment.browser)
  ) {
    issue(
      issues,
      'missing-browser-metadata',
      '$.environment.browser',
      'browser name and version are required',
    );
  }

  if (
    !isRecord(input.scenario) ||
    !isNonEmptyString(input.scenario.feature) ||
    !isNonEmptyString(input.scenario.scenario) ||
    !isNonEmptyString(input.scenario.expectedResult)
  ) {
    issue(
      issues,
      'missing-scenario-metadata',
      '$.scenario',
      'feature, scenario, and expectedResult are required',
    );
  }

  if (!isRecord(input.artifact)) {
    issue(issues, 'missing-artifact', '$.artifact', 'artifact is required');
  } else {
    requiredString(input.artifact, 'locator', '$.artifact.locator', issues);
    if (!isNonEmptyString(input.artifact.sha256) || !SHA256_PATTERN.test(input.artifact.sha256)) {
      issue(
        issues,
        'invalid-artifact-digest',
        '$.artifact.sha256',
        'sha256 must be a hexadecimal SHA-256 digest',
      );
    }
    const expiresAtMs = requiredTimestamp(
      input.artifact,
      'expiresAt',
      '$.artifact.expiresAt',
      issues,
    );
    if (expiresAtMs !== undefined && expiresAtMs <= nowMs) {
      issue(issues, 'expired-artifact', '$.artifact.expiresAt', 'artifact has expired');
    }
  }

  if (!isRecord(input.verification)) {
    issue(issues, 'missing-verification', '$.verification', 'verification is required');
    return;
  }

  requiredString(input.verification, 'verifier', '$.verification.verifier', issues);
  requiredString(input.verification, 'version', '$.verification.version', issues);
  const verifiedAtMs = requiredTimestamp(
    input.verification,
    'verifiedAt',
    '$.verification.verifiedAt',
    issues,
  );
  if (input.verification.result !== 'pass') {
    issue(issues, 'verification-failed', '$.verification.result', 'verification must pass');
  }
  if (capturedAtMs !== undefined && verifiedAtMs !== undefined && verifiedAtMs < capturedAtMs) {
    issue(
      issues,
      'verification-before-capture',
      '$.verification.verifiedAt',
      'verification cannot predate capture',
    );
  }
  if (
    isNonEmptyString(input.verification.verifier) &&
    isNonEmptyString(input.verification.version) &&
    !isTrustedVerifier(input.verification.verifier, input.verification.version, trustedVerifiers)
  ) {
    issue(
      issues,
      'untrusted-verifier',
      '$.verification.verifier',
      `verifier is not trusted: ${input.verification.verifier}@${input.verification.version}`,
    );
  }
}

function result<TPayload = unknown>(
  status: EvidenceValidationStatus,
  issues: EvidenceValidationIssue[],
  claimedEvidenceLevel?: EvidenceLevel,
  claimedReadinessStatus?: ReadinessStatus,
): EvidenceValidationResult<TPayload> {
  return { status, claimedEvidenceLevel, claimedReadinessStatus, issues };
}

function issue(
  issues: EvidenceValidationIssue[],
  code: EvidenceValidationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function validateNamedVersion(
  value: unknown,
  path: string,
  issues: EvidenceValidationIssue[],
): void {
  if (!isRecord(value)) {
    issue(issues, 'invalid-envelope', path, `${path} must be an object`);
    return;
  }
  requiredString(value, 'name', `${path}.name`, issues);
  requiredString(value, 'version', `${path}.version`, issues);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: EvidenceValidationIssue[],
): void {
  if (!isNonEmptyString(record[key])) {
    issue(issues, 'invalid-envelope', path, `${key} must be a non-empty string`);
  }
}

function requiredTimestamp(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: EvidenceValidationIssue[],
): number | undefined {
  const value = record[key];
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(parsed)) {
    issue(issues, 'invalid-timestamp', path, `${key} must be a valid timestamp`);
    return undefined;
  }
  return parsed;
}

function isTrustedVerifier(
  name: string,
  version: string,
  trusted: readonly TrustedEvidenceVerifier[],
): boolean {
  return trusted.some(
    (entry) => entry.name === name && (entry.version === undefined || entry.version === version),
  );
}

function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return typeof value === 'string' && EVIDENCE_LEVELS.includes(value as EvidenceLevel);
}

function isReadinessStatus(value: unknown): value is ReadinessStatus {
  return typeof value === 'string' && READINESS_STATUSES.includes(value as ReadinessStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNamedVersion(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.name) && isNonEmptyString(value.version);
}

function isBrowserSurface(value: unknown): boolean {
  return typeof value === 'string' && (value.startsWith('browser-') || value.startsWith('extension-'));
}

function resolveNow(value: EvidenceValidationOptions['now']): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function normalizeSha256(value: string): string {
  return value.toLowerCase().replace(/^sha256:/, '');
}

async function sha256Hex(content: ArtifactContent): Promise<string> {
  const source =
    typeof content === 'string'
      ? new TextEncoder().encode(content)
      : content instanceof Uint8Array
        ? content
        : new Uint8Array(content);
  // Web Crypto's BufferSource typing requires an ArrayBuffer-backed view.
  // Copy even Uint8Array inputs so SharedArrayBuffer-backed data cannot leak
  // an ArrayBufferLike type into subtle.digest().
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
