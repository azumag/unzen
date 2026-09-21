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

type CanonicalArtifactContent = string | Uint8Array<ArrayBuffer>;

type CapturedIndependentEvidenceVerification = {
  verifier: unknown;
  version: unknown;
  verifiedAt: unknown;
  result: unknown;
  reason: unknown;
};

type EvidenceValidationPolicySnapshot = {
  nowMs: number;
  supportedSchemaVersions: readonly string[];
  trustedVerifiers: readonly TrustedEvidenceVerifier[];
};

type CapturedEvidenceClaimSnapshot = {
  artifactLocator: unknown;
  artifactSha256: unknown;
  artifactExpiresAt: unknown;
  verificationVerifier: unknown;
  verificationVersion: unknown;
  verificationVerifiedAt: unknown;
  verificationResult: unknown;
};

type EvidenceMetadataSnapshot = {
  producer: Record<string, unknown> | undefined;
  producerName: unknown;
  producerVersion: unknown;
  environment: Record<string, unknown> | undefined;
  environmentRuntime: unknown;
  environmentRuntimeVersion: unknown;
  environmentExecutionSurface: unknown;
  redaction: Record<string, unknown> | undefined;
  redactionApplied: unknown;
  redactionPolicyVersion: unknown;
};

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
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
)?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteOffset',
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;

export async function validateEvidenceEnvelope<TPayload = unknown>(
  input: unknown,
  options: EvidenceValidationOptions = {},
): Promise<EvidenceValidationResult<TPayload>> {
  const issues: EvidenceValidationIssue[] = [];
  const policy = snapshotValidationPolicy(options);
  if (!isRecord(input)) {
    issue(issues, 'invalid-envelope', '$', 'evidence envelope must be an object');
    return result<TPayload>('invalid', issues);
  }

  const schemaVersion = readPropertySafely(input, 'schemaVersion');
  const evidenceLevel = readPropertySafely(input, 'evidenceLevel');
  const readinessStatus = readPropertySafely(input, 'readinessStatus');
  const level = isEvidenceLevel(evidenceLevel) ? evidenceLevel : undefined;
  const readiness = isReadinessStatus(readinessStatus) ? readinessStatus : undefined;
  const metadata = snapshotEvidenceMetadata(input);
  const capturedAtMs = validateBase(input, metadata, issues, policy.nowMs, schemaVersion);

  if (!level) {
    issue(issues, 'invalid-evidence-level', '$.evidenceLevel', 'invalid evidence level');
  }
  if (!readiness) {
    issue(issues, 'invalid-readiness-status', '$.readinessStatus', 'invalid readiness status');
  }

  if (
    typeof schemaVersion === 'string'
    && !policy.supportedSchemaVersions.includes(schemaVersion)
  ) {
    issue(
      issues,
      'unsupported-schema-version',
      '$.schemaVersion',
      `unsupported evidence schema version: ${schemaVersion}`,
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

  let capturedClaims: CapturedEvidenceClaimSnapshot | undefined;
  if (level === 'captured-and-verified') {
    capturedClaims = validateCaptured(
      input,
      metadata,
      issues,
      policy.nowMs,
      capturedAtMs,
      policy.trustedVerifiers,
    );
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
  const claims = capturedClaims as CapturedEvidenceClaimSnapshot;
  const expectedSha256 = normalizeSha256(claims.artifactSha256 as string);
  const expectedVerification = {
    verifier: claims.verificationVerifier as string,
    version: claims.verificationVersion as string,
    verifiedAt: claims.verificationVerifiedAt as string,
  } as const;

  let loadArtifact: EvidenceValidationOptions['loadArtifact'];
  try {
    loadArtifact = options.loadArtifact;
  } catch {
    issue(
      issues,
      'artifact-unavailable',
      '$.artifact.locator',
      'captured-and-verified evidence requires an external artifact loader',
    );
    return result<TPayload>('not-evaluated', issues, level, readiness);
  }

  if (!loadArtifact) {
    issue(
      issues,
      'artifact-unavailable',
      '$.artifact.locator',
      'captured-and-verified evidence requires an external artifact loader',
    );
    return result<TPayload>('not-evaluated', issues, level, readiness);
  }

  // Capture the verifier before invoking the loader so one validation operation
  // cannot have its independent-verifier policy replaced across the await.
  let verifyArtifact: EvidenceValidationOptions['verifyArtifact'];
  try {
    verifyArtifact = options.verifyArtifact;
  } catch {
    issue(
      issues,
      'verification-unavailable',
      '$.verification',
      'captured-and-verified evidence requires an independent verifier callback',
    );
    return result<TPayload>('not-evaluated', issues, level, readiness);
  }

  let artifactContent: CanonicalArtifactContent;
  try {
    const loadedArtifact = await loadArtifact(claims.artifactLocator as string);
    artifactContent = snapshotArtifactContent(loadedArtifact);
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
  if (actualSha256 !== expectedSha256) {
    issue(
      issues,
      'artifact-digest-mismatch',
      '$.artifact.sha256',
      `artifact digest mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    );
    return result<TPayload>('invalid', issues, level, readiness);
  }

  if (!verifyArtifact) {
    issue(
      issues,
      'verification-unavailable',
      '$.verification',
      'captured-and-verified evidence requires an independent verifier callback',
    );
    return result<TPayload>('not-evaluated', issues, level, readiness);
  }

  let attestation: CapturedIndependentEvidenceVerification;
  try {
    const runtimeAttestation = (await verifyArtifact({
      envelope: captured,
      artifactContent,
      actualSha256,
    })) as unknown as Record<string, unknown>;
    attestation = {
      verifier: runtimeAttestation.verifier,
      version: runtimeAttestation.version,
      verifiedAt: runtimeAttestation.verifiedAt,
      result: runtimeAttestation.result,
      reason: runtimeAttestation.reason,
    };
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
    attestation.verifier !== expectedVerification.verifier ||
    attestation.version !== expectedVerification.version ||
    attestation.verifiedAt !== expectedVerification.verifiedAt
  ) {
    issue(
      issues,
      'verification-attestation-mismatch',
      '$.verification',
      typeof attestation.reason === 'string'
        ? attestation.reason
        : 'independent verifier attestation does not match the envelope',
    );
    return result<TPayload>('invalid', issues, level, readiness);
  }

  // validateCaptured() already established that the captured verifier/version is trusted.
  // Because the runtime attestation must exactly match those captured claims above, re-reading
  // caller-owned trustedVerifiers after an awaited callback would only introduce a TOCTOU.
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
  metadata: EvidenceMetadataSnapshot,
  issues: EvidenceValidationIssue[],
  nowMs: number,
  schemaVersion: unknown,
): number | undefined {
  if (!isNonEmptyString(schemaVersion)) {
    issue(
      issues,
      'invalid-envelope',
      '$.schemaVersion',
      'schemaVersion must be a non-empty string',
    );
  }
  requiredString(input, 'evidenceKind', '$.evidenceKind', issues);
  requiredString(input, 'runId', '$.runId', issues);
  const capturedAtMs = requiredTimestamp(input, 'capturedAt', '$.capturedAt', issues);
  if (capturedAtMs !== undefined && capturedAtMs > nowMs + MAX_CLOCK_SKEW_MS) {
    issue(issues, 'future-captured-at', '$.capturedAt', 'capturedAt exceeds clock skew');
  }

  if (!metadata.producer) {
    issue(issues, 'invalid-envelope', '$.producer', '$.producer must be an object');
  } else {
    requiredStringValue(metadata.producerName, 'name', '$.producer.name', issues);
    requiredStringValue(metadata.producerVersion, 'version', '$.producer.version', issues);
  }

  if (!metadata.environment) {
    issue(issues, 'invalid-envelope', '$.environment', 'environment must be an object');
  } else {
    requiredStringValue(
      metadata.environmentRuntime,
      'runtime',
      '$.environment.runtime',
      issues,
    );
    requiredStringValue(
      metadata.environmentRuntimeVersion,
      'runtimeVersion',
      '$.environment.runtimeVersion',
      issues,
    );
    requiredStringValue(
      metadata.environmentExecutionSurface,
      'executionSurface',
      '$.environment.executionSurface',
      issues,
    );
  }

  if (!metadata.redaction) {
    issue(issues, 'invalid-envelope', '$.redaction', 'redaction must be an object');
  } else {
    if (typeof metadata.redactionApplied !== 'boolean') {
      issue(issues, 'invalid-envelope', '$.redaction.applied', 'applied must be boolean');
    }
    requiredStringValue(
      metadata.redactionPolicyVersion,
      'policyVersion',
      '$.redaction.policyVersion',
      issues,
    );
  }

  if (!hasOwnPropertySafely(input, 'payload')) {
    issue(issues, 'invalid-envelope', '$.payload', 'payload is required');
  }
  return capturedAtMs;
}

function validateCaptured(
  input: Record<string, unknown>,
  metadata: EvidenceMetadataSnapshot,
  issues: EvidenceValidationIssue[],
  nowMs: number,
  capturedAtMs: number | undefined,
  trustedVerifiers: readonly TrustedEvidenceVerifier[],
): CapturedEvidenceClaimSnapshot {
  const producerCommitSha = metadata.producer
    ? readPropertySafely(metadata.producer, 'commitSha')
    : undefined;
  if (!isNonEmptyString(producerCommitSha)) {
    issue(
      issues,
      'missing-producer-commit-sha',
      '$.producer.commitSha',
      'producer.commitSha is required',
    );
  }

  const environmentOs = metadata.environment
    ? snapshotNamedVersion(readPropertySafely(metadata.environment, 'os'))
    : undefined;
  if (!environmentOs) {
    issue(
      issues,
      'missing-environment-metadata',
      '$.environment.os',
      'OS name and version are required',
    );
  } else if (isBrowserSurface(metadata.environmentExecutionSurface)) {
    const environmentBrowser = metadata.environment
      ? snapshotNamedVersion(readPropertySafely(metadata.environment, 'browser'))
      : undefined;
    if (!environmentBrowser) {
      issue(
        issues,
        'missing-browser-metadata',
        '$.environment.browser',
        'browser name and version are required',
      );
    }
  }

  const scenario = readRecordPropertySafely(input, 'scenario');
  if (!scenario) {
    issue(
      issues,
      'missing-scenario-metadata',
      '$.scenario',
      'feature, scenario, and expectedResult are required',
    );
  } else {
    const scenarioFeature = readPropertySafely(scenario, 'feature');
    const scenarioName = readPropertySafely(scenario, 'scenario');
    const scenarioExpectedResult = readPropertySafely(scenario, 'expectedResult');
    if (
      !isNonEmptyString(scenarioFeature) ||
      !isNonEmptyString(scenarioName) ||
      !isNonEmptyString(scenarioExpectedResult)
    ) {
      issue(
        issues,
        'missing-scenario-metadata',
        '$.scenario',
        'feature, scenario, and expectedResult are required',
      );
    }
  }

  let artifactLocator: unknown;
  let artifactSha256: unknown;
  let artifactExpiresAt: unknown;
  const artifact = readRecordPropertySafely(input, 'artifact');
  if (!artifact) {
    issue(issues, 'missing-artifact', '$.artifact', 'artifact is required');
  } else {
    artifactLocator = readPropertySafely(artifact, 'locator');
    artifactSha256 = readPropertySafely(artifact, 'sha256');
    artifactExpiresAt = readPropertySafely(artifact, 'expiresAt');
    requiredStringValue(artifactLocator, 'locator', '$.artifact.locator', issues);
    if (!isNonEmptyString(artifactSha256) || !SHA256_PATTERN.test(artifactSha256)) {
      issue(
        issues,
        'invalid-artifact-digest',
        '$.artifact.sha256',
        'sha256 must be a hexadecimal SHA-256 digest',
      );
    }
    const expiresAtMs = requiredTimestampValue(
      artifactExpiresAt,
      'expiresAt',
      '$.artifact.expiresAt',
      issues,
    );
    if (expiresAtMs !== undefined && expiresAtMs <= nowMs) {
      issue(issues, 'expired-artifact', '$.artifact.expiresAt', 'artifact has expired');
    }
  }

  let verificationVerifier: unknown;
  let verificationVersion: unknown;
  let verificationVerifiedAt: unknown;
  let verificationResult: unknown;
  const verification = readRecordPropertySafely(input, 'verification');
  if (!verification) {
    issue(issues, 'missing-verification', '$.verification', 'verification is required');
    return {
      artifactLocator,
      artifactSha256,
      artifactExpiresAt,
      verificationVerifier,
      verificationVersion,
      verificationVerifiedAt,
      verificationResult,
    };
  }

  verificationVerifier = readPropertySafely(verification, 'verifier');
  verificationVersion = readPropertySafely(verification, 'version');
  verificationVerifiedAt = readPropertySafely(verification, 'verifiedAt');
  verificationResult = readPropertySafely(verification, 'result');
  requiredStringValue(verificationVerifier, 'verifier', '$.verification.verifier', issues);
  requiredStringValue(verificationVersion, 'version', '$.verification.version', issues);
  const verifiedAtMs = requiredTimestampValue(
    verificationVerifiedAt,
    'verifiedAt',
    '$.verification.verifiedAt',
    issues,
  );
  if (verificationResult !== 'pass') {
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
    isNonEmptyString(verificationVerifier) &&
    isNonEmptyString(verificationVersion) &&
    !isTrustedVerifier(verificationVerifier, verificationVersion, trustedVerifiers)
  ) {
    issue(
      issues,
      'untrusted-verifier',
      '$.verification.verifier',
      `verifier is not trusted: ${verificationVerifier}@${verificationVersion}`,
    );
  }

  return {
    artifactLocator,
    artifactSha256,
    artifactExpiresAt,
    verificationVerifier,
    verificationVersion,
    verificationVerifiedAt,
    verificationResult,
  };
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
  requiredStringValue(readPropertySafely(record, key), key, path, issues);
}

function requiredStringValue(
  value: unknown,
  key: string,
  path: string,
  issues: EvidenceValidationIssue[],
): void {
  if (!isNonEmptyString(value)) {
    issue(issues, 'invalid-envelope', path, `${key} must be a non-empty string`);
  }
}

function requiredTimestamp(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: EvidenceValidationIssue[],
): number | undefined {
  return requiredTimestampValue(readPropertySafely(record, key), key, path, issues);
}

function requiredTimestampValue(
  value: unknown,
  key: string,
  path: string,
  issues: EvidenceValidationIssue[],
): number | undefined {
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

function snapshotEvidenceMetadata(input: Record<string, unknown>): EvidenceMetadataSnapshot {
  const producer = readRecordPropertySafely(input, 'producer');
  const environment = readRecordPropertySafely(input, 'environment');
  const redaction = readRecordPropertySafely(input, 'redaction');
  return {
    producer,
    producerName: producer ? readPropertySafely(producer, 'name') : undefined,
    producerVersion: producer ? readPropertySafely(producer, 'version') : undefined,
    environment,
    environmentRuntime: environment ? readPropertySafely(environment, 'runtime') : undefined,
    environmentRuntimeVersion: environment
      ? readPropertySafely(environment, 'runtimeVersion')
      : undefined,
    environmentExecutionSurface: environment
      ? readPropertySafely(environment, 'executionSurface')
      : undefined,
    redaction,
    redactionApplied: redaction ? readPropertySafely(redaction, 'applied') : undefined,
    redactionPolicyVersion: redaction
      ? readPropertySafely(redaction, 'policyVersion')
      : undefined,
  };
}

function readRecordPropertySafely(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = readPropertySafely(record, key);
  return isRecord(value) ? value : undefined;
}

function readPropertySafely(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function hasOwnPropertySafely(record: Record<string, unknown>, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(record, key);
  } catch {
    return false;
  }
}

function snapshotNamedVersion(value: unknown): { name: string; version: string } | undefined {
  if (!isRecord(value)) return undefined;
  const name = readPropertySafely(value, 'name');
  const version = readPropertySafely(value, 'version');
  if (!isNonEmptyString(name) || !isNonEmptyString(version)) return undefined;
  return { name, version };
}

function snapshotValidationPolicy(
  options: EvidenceValidationOptions,
): EvidenceValidationPolicySnapshot {
  let now: EvidenceValidationOptions['now'];
  try {
    now = options.now;
  } catch {
    now = undefined;
  }

  let supportedSchemaVersions: EvidenceValidationOptions['supportedSchemaVersions'];
  try {
    supportedSchemaVersions = options.supportedSchemaVersions;
  } catch {
    supportedSchemaVersions = [];
  }

  let trustedVerifiers: EvidenceValidationOptions['trustedVerifiers'];
  try {
    trustedVerifiers = options.trustedVerifiers;
  } catch {
    trustedVerifiers = [];
  }

  return {
    nowMs: resolveNowSafely(now),
    supportedSchemaVersions: snapshotSupportedSchemaVersions(supportedSchemaVersions),
    trustedVerifiers: snapshotTrustedVerifiers(trustedVerifiers),
  };
}

function snapshotSupportedSchemaVersions(
  supported: readonly string[] | undefined,
): readonly string[] {
  if (supported === undefined) return [EVIDENCE_SCHEMA_VERSION];
  try {
    if (!Array.isArray(supported)) return [];
    const length = supported.length;
    if (!Number.isSafeInteger(length) || length < 0) return [];
    const snapshot: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const version = supported[index];
      if (typeof version !== 'string') return [];
      snapshot.push(version);
    }
    return snapshot;
  } catch {
    return [];
  }
}

function snapshotTrustedVerifiers(
  trusted: readonly TrustedEvidenceVerifier[] | undefined,
): readonly TrustedEvidenceVerifier[] {
  if (trusted === undefined) return [];
  try {
    if (!Array.isArray(trusted)) return [];
    const length = trusted.length;
    if (!Number.isSafeInteger(length) || length < 0) return [];
    const snapshot: TrustedEvidenceVerifier[] = [];
    for (let index = 0; index < length; index += 1) {
      const entry = trusted[index] as unknown;
      if (!isRecord(entry)) return [];
      const name = entry.name;
      const version = entry.version;
      if (!isNonEmptyString(name)) return [];
      if (version !== undefined && !isNonEmptyString(version)) return [];
      snapshot.push(version === undefined ? { name } : { name, version });
    }
    return snapshot;
  } catch {
    return [];
  }
}

function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return typeof value === 'string' && EVIDENCE_LEVELS.includes(value as EvidenceLevel);
}

function isReadinessStatus(value: unknown): value is ReadinessStatus {
  return typeof value === 'string' && READINESS_STATUSES.includes(value as ReadinessStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
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

function resolveNowSafely(value: EvidenceValidationOptions['now']): number {
  try {
    return resolveNow(value);
  } catch {
    return Date.now();
  }
}

function normalizeSha256(value: string): string {
  return value.toLowerCase().replace(/^sha256:/, '');
}

function snapshotArtifactContent(content: unknown): CanonicalArtifactContent {
  if (typeof content === 'string') return content;

  const uint8Snapshot = snapshotUint8Array(content);
  if (uint8Snapshot) return uint8Snapshot;

  const arrayBufferSnapshot = snapshotArrayBuffer(content);
  if (arrayBufferSnapshot) return arrayBufferSnapshot;

  throw new TypeError('artifact loader must return a string, ArrayBuffer, or Uint8Array');
}

function snapshotUint8Array(content: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (!ArrayBuffer.isView(content) || !(content instanceof Uint8Array)) return undefined;
  if (
    !TYPED_ARRAY_BUFFER_GETTER ||
    !TYPED_ARRAY_BYTE_OFFSET_GETTER ||
    !TYPED_ARRAY_BYTE_LENGTH_GETTER
  ) {
    return undefined;
  }

  try {
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, content, []) as ArrayBufferLike;
    const byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, content, []) as number;
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, content, []) as number;
    const source = new Uint8Array(buffer, byteOffset, byteLength);
    const snapshot = new Uint8Array(byteLength);
    Uint8Array.prototype.set.call(snapshot, source);
    return snapshot;
  } catch {
    return undefined;
  }
}

function snapshotArrayBuffer(content: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (typeof content !== 'object' || content === null || !ARRAY_BUFFER_BYTE_LENGTH_GETTER) {
    return undefined;
  }

  try {
    const byteLength = Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, content, []) as number;
    const source = new Uint8Array(content as ArrayBuffer);
    if (source.byteLength !== byteLength) return undefined;
    const snapshot = new Uint8Array(byteLength);
    Uint8Array.prototype.set.call(snapshot, source);
    return snapshot;
  } catch {
    return undefined;
  }
}

async function sha256Hex(content: CanonicalArtifactContent): Promise<string> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function formatError(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      return typeof message === 'string' ? message : String(message);
    }
    return String(error);
  } catch {
    return 'uninspectable thrown value';
  }
}
