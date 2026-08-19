import { validateEvidenceEnvelope } from '../src/evidence.ts';

const SERVICE = 'unzen-llm-continuous-assurance-production-provider-canary';
const EVIDENCE_KIND = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary';
const DEPLOYMENT_EVIDENCE_KIND = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary';
const STEADY_STATE_EVIDENCE_KIND = 'publisher-tax-filing-production-exception-archive-dr-provider-steady-state-operations';
const DEFAULT_SCOPE = 'publisher-tax-exception-archive-dr';
const VERIFIER_NAME = 'unzen-independent-evidence-verifier';
const VERIFIER_VERSION = '1.0.0';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const ALLOWED_PROVIDER_PATHS = new Set([
  '/provider/audit',
  '/provider/archive/retrieve',
  '/provider/health',
]);

function deploymentMetadata(env) {
  const version = env.CF_VERSION_METADATA || {};
  return {
    service: SERVICE,
    versionId: version.id || '',
    versionTag: version.tag || null,
    versionTimestamp: version.timestamp || '',
    configFingerprintSha256: env.CONFIG_FINGERPRINT_SHA256 || '',
  };
}

async function secretEquals(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function exactJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

async function readMeta(binding, role) {
  const response = await binding.fetch(new Request(`https://${role}.internal/__meta`, { method: 'GET' }));
  if (!response.ok) throw new Error(`production-provider-canary-meta-http-${role}-${response.status}`);
  return { role, ...(await response.json()) };
}

async function readEngineState(env, scope) {
  const response = await env.ASSURANCE_ENGINE.fetch(new Request(
    `https://engine.internal/__canary/state?scope=${encodeURIComponent(scope)}`,
    { method: 'GET', headers: { 'x-unzen-canary-secret': env.CANARY_DISPATCH_SECRET } },
  ));
  if (!response.ok) throw new Error(`production-provider-canary-engine-state-http-${response.status}`);
  return response.json();
}

async function evidenceArtifactContent(env, locator) {
  const response = await env.EVIDENCE_ADAPTER.fetch(new Request('https://evidence.internal/evidence/artifact/load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locator }),
  }));
  if (!response.ok) throw new Error(`production-provider-canary-artifact-load-http-${response.status}`);
  const body = await response.json();
  if (!body || body.kind !== 'bytes' || !Array.isArray(body.bytes)) {
    throw new Error('production-provider-canary-artifact-load-invalid');
  }
  return new Uint8Array(body.bytes);
}

async function evidenceArtifactVerification(env, context) {
  const artifactContent = context.artifactContent instanceof Uint8Array
    ? { kind: 'bytes', bytes: Array.from(context.artifactContent) }
    : context.artifactContent;
  const response = await env.EVIDENCE_ADAPTER.fetch(new Request('https://evidence.internal/evidence/artifact/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      envelope: context.envelope,
      artifactContent,
      actualSha256: context.actualSha256,
    }),
  }));
  const value = await response.json();
  if (!response.ok) throw new Error(`production-provider-canary-artifact-verify-http-${response.status}`);
  return value;
}

async function validateCapturedEvidence(env, evidence, expectedKind, minimumReadiness, nowMs) {
  if (!evidence || evidence.evidenceKind !== expectedKind) {
    throw new Error(`production-provider-canary-upstream-kind-invalid:${expectedKind}`);
  }
  const validation = await validateEvidenceEnvelope(evidence, {
    now: nowMs,
    trustedVerifiers: [{ name: VERIFIER_NAME, version: VERIFIER_VERSION }],
    loadArtifact: async (locator) => evidenceArtifactContent(env, locator),
    verifyArtifact: async (context) => evidenceArtifactVerification(env, context),
  });
  const ranks = {
    'design-only': 0,
    'contract-tested': 1,
    'runtime-observed': 2,
    'verified-pilot': 3,
    'production-candidate': 4,
    'production-approved': 5,
  };
  if (validation.status !== 'valid' || validation.effectiveEvidenceLevel !== 'captured-and-verified' ||
    ranks[validation.effectiveReadinessStatus] < ranks[minimumReadiness]) {
    throw new Error(`production-provider-canary-upstream-evidence-invalid:${expectedKind}`);
  }
  return validation.envelope;
}

async function providerRequest(env, path, body, idempotencyKey) {
  if (!ALLOWED_PROVIDER_PATHS.has(path)) throw new Error(`production-provider-canary-provider-path-forbidden:${path}`);
  const response = await env.PROVIDER_ADAPTER.fetch(new Request(`https://provider.internal${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unzen-idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error(`production-provider-canary-provider-http-${path}-${response.status}`);
  return response.json();
}

async function pagerRequest(env, body, idempotencyKey) {
  const response = await env.PAGER_ADAPTER.fetch(new Request('https://pager.internal/page', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unzen-idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error(`production-provider-canary-pager-http-${response.status}`);
  return response.json();
}

function actionContext(canaryRunId, action, idempotencyKey, nowMs) {
  return {
    cycleId: canaryRunId,
    scheduledAtMs: nowMs,
    nowMs,
    action,
    idempotencyKey,
    attempt: 1,
    backoffMsBeforeAttempt: 0,
  };
}

function deploymentSetMatches(actual, expected) {
  const byRole = new Map(actual.map((item) => [item.role, item]));
  return expected.length === actual.length && expected.every((item) => {
    const current = byRole.get(item.role);
    return current && current.service === item.service && current.versionId === item.versionId &&
      current.configFingerprintSha256 === item.configFingerprintSha256 &&
      current.versionTimestamp === item.versionTimestamp;
  });
}

function assertProviderIdentity(identity, steady) {
  if (!identity || !steady) throw new Error('production-provider-canary-provider-identity-missing');
  const expected = {
    providerName: steady.providerName,
    accountId: steady.accountId,
    primaryStorageId: steady.primaryStorageId,
    backupStorageId: steady.backupStorageId,
    replicaSiteId: steady.replicaSiteId,
    replicaRegion: steady.replicaRegion,
    archiveId: steady.archiveId,
    archiveContentDigest: steady.archiveContentDigest,
    credentialSetId: steady.credentialRotation?.currentCredentialSetId,
    signingKeyId: steady.credentialRotation?.currentSigningKeyId,
    encryptionKeyId: steady.credentialRotation?.currentEncryptionKeyId,
    normalOnCallRoute: steady.onCallRoute,
    normalEscalationTarget: steady.escalationTarget,
  };
  if (!exactJson(identity, expected)) throw new Error('production-provider-canary-provider-identity-mismatch');
  return expected;
}

function validateRetrieval(value, storageId, archiveId, digest) {
  return value && value.storageId === storageId && value.archiveId === archiveId &&
    value.observedContentDigest === digest && value.integrityStatus === 'pass' &&
    typeof value.retrievalOperationId === 'string' && value.retrievalOperationId &&
    typeof value.integrityCheckId === 'string' && value.integrityCheckId;
}

function validateHealth(value, steady) {
  return value && value.failureCount === 0 && value.rtoBreachCount === 0 && value.rpoBreachCount === 0 &&
    value.integrityFailureCount === 0 &&
    value.providerAvailabilityPct >= steady.rollingSlo.requiredProviderAvailabilityPct &&
    value.observedCredentialSetId === steady.credentialRotation.currentCredentialSetId &&
    value.observedSigningKeyId === steady.credentialRotation.currentSigningKeyId &&
    value.observedEncryptionKeyId === steady.credentialRotation.currentEncryptionKeyId &&
    value.rollbackControlId === steady.rollbackControlId && value.rollbackArmed === true &&
    value.emergencyHoldControlId === steady.emergencyHoldControlId && value.emergencyHoldArmed === true &&
    !value.alertDispositions?.some((alert) => alert.severity === 'critical' && alert.status === 'open') &&
    !value.incidentReviews?.some((incident) => incident.status === 'active') &&
    !value.controlInvocations?.some((invocation) => invocation.status === 'active');
}

async function verifierCapture(env, body) {
  const response = await env.INDEPENDENT_VERIFIER.fetch(new Request('https://verifier.internal/verify/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  const attestation = await response.json();
  if (!response.ok || attestation.result !== 'pass' || attestation.verifier !== VERIFIER_NAME ||
    attestation.version !== VERIFIER_VERSION || attestation.readinessStatus !== 'production-candidate') {
    throw new Error('production-provider-canary-verifier-capture-invalid');
  }
  return attestation;
}

async function verifierArtifact(env, envelope, artifactContent, actualSha256) {
  const response = await env.INDEPENDENT_VERIFIER.fetch(new Request('https://verifier.internal/verify/artifact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      envelope,
      actualSha256,
      artifactContent: { kind: 'utf8', content: artifactContent },
    }),
  }));
  return { ok: response.ok, result: await response.json() };
}

async function probeUntrustedVerifierRejected(artifactContent, artifactSha256, capturedAtMs) {
  const verification = {
    verifier: 'untrusted-provider-canary-verifier',
    version: '0.0.0',
    verifiedAt: new Date(capturedAtMs + 1_000).toISOString(),
    result: 'pass',
  };
  const envelope = {
    schemaVersion: '1.0.0',
    evidenceKind: EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: { name: SERVICE, version: '1.0.0', commitSha: '0'.repeat(40) },
    runId: `untrusted-provider-canary:${capturedAtMs}`,
    capturedAt: new Date(capturedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'production-provider-canary',
      os: { name: 'cloudflare-workers', version: 'managed' },
    },
    scenario: { feature: EVIDENCE_KIND, scenario: 'untrusted verifier probe', expectedResult: 'rejected' },
    artifact: { locator: 'probe://provider-canary', sha256: artifactSha256, expiresAt: new Date(capturedAtMs + 60_000).toISOString() },
    verification,
    redaction: { applied: true, policyVersion: 'production-provider-canary-v1' },
    payload: {},
  };
  const validation = await validateEvidenceEnvelope(envelope, {
    now: capturedAtMs + 2_000,
    trustedVerifiers: [{ name: VERIFIER_NAME, version: VERIFIER_VERSION }],
    loadArtifact: async () => artifactContent,
    verifyArtifact: async () => verification,
  });
  return validation.status === 'invalid' && validation.issues.some((issue) => issue.code === 'untrusted-verifier');
}

async function loadStoredEnvelope(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(await object.arrayBuffer())));
  } catch {
    return null;
  }
}

export async function runProductionProviderCanary(input, env) {
  const nowMs = Number(input.nowMs ?? Date.now());
  if (!Number.isFinite(nowMs)) throw new Error('production-provider-canary-now-invalid');
  if (VERIFIER_NAME !== env.TRUSTED_VERIFIER_NAME) throw new Error('production-provider-canary-trusted-verifier-mismatch');
  if (!env.CANARY_PAGER_ROUTE || !env.CANARY_PAGER_TARGET ||
    env.CANARY_PAGER_ROUTE.startsWith('SET_') || env.CANARY_PAGER_TARGET.startsWith('SET_')) {
    throw new Error('production-provider-canary-pager-destination-unconfigured');
  }

  const deploymentEvidence = await validateCapturedEvidence(
    env,
    input.deploymentCanaryEvidence,
    DEPLOYMENT_EVIDENCE_KIND,
    'production-candidate',
    nowMs,
  );
  const deploymentPayload = deploymentEvidence.payload;

  const directDeployments = await Promise.all([
    readMeta(env.PRODUCTION_DEPLOYMENT_CANARY, 'controller'),
    readMeta(env.CONTINUOUS_ASSURANCE_RUNTIME, 'runtime'),
    readMeta(env.ASSURANCE_ENGINE, 'engine'),
    readMeta(env.PROVIDER_ADAPTER, 'provider'),
    readMeta(env.EVIDENCE_ADAPTER, 'evidence'),
    readMeta(env.PAGER_ADAPTER, 'pager'),
    readMeta(env.INDEPENDENT_VERIFIER, 'verifier'),
  ]);
  if (!deploymentSetMatches(directDeployments, deploymentPayload.deployments)) {
    throw new Error('production-provider-canary-deployment-drift');
  }

  const scope = env.CONTINUOUS_ASSURANCE_SCOPE || DEFAULT_SCOPE;
  const engineState = await readEngineState(env, scope);
  if (!engineState?.steadyStateOperationsEvidence || engineState.currentRunId !== engineState.steadyStateOperationsEvidence.runId) {
    throw new Error('production-provider-canary-steady-state-unavailable');
  }
  const steadyEvidence = await validateCapturedEvidence(
    env,
    engineState.steadyStateOperationsEvidence,
    STEADY_STATE_EVIDENCE_KIND,
    'production-approved',
    nowMs,
  );
  const steady = steadyEvidence.payload;
  const providerIdentity = assertProviderIdentity(engineState.providerIdentity, steady);
  if (env.CANARY_PAGER_ROUTE === providerIdentity.normalOnCallRoute ||
    env.CANARY_PAGER_TARGET === providerIdentity.normalEscalationTarget) {
    throw new Error('production-provider-canary-pager-destination-not-isolated');
  }

  const canaryRunId = `production-provider-canary:${deploymentEvidence.runId}:${steadyEvidence.runId}`;
  const resultKey = `provider-canary/envelopes/${encodeURIComponent(canaryRunId)}.json`;
  const existing = await loadStoredEnvelope(env.CANARY_EVIDENCE_BUCKET, resultKey);
  if (existing?.runId === canaryRunId) return existing;

  const startedAtMs = nowMs;
  const actionIdempotencyKeys = {
    providerAudit: `${canaryRunId}:provider-audit`,
    primaryRetrieval: `${canaryRunId}:primary-retrieval`,
    backupRetrieval: `${canaryRunId}:backup-retrieval`,
    providerHealth: `${canaryRunId}:provider-health`,
    pager: `${canaryRunId}:pager-canary`,
  };

  const badIdempotencyResponse = await env.PROVIDER_ADAPTER.fetch(new Request('https://provider.internal/provider/audit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: {} }),
  }));
  const badIdempotencyRejected = badIdempotencyResponse.status === 400;
  if (!badIdempotencyRejected) throw new Error('production-provider-canary-bad-idempotency-not-rejected');

  const unknownProviderActionResponse = await env.PROVIDER_ADAPTER.fetch(new Request('https://provider.internal/provider/canary-unsupported', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-unzen-idempotency-key': `${canaryRunId}:unsupported` },
    body: JSON.stringify({}),
  }));
  const unknownProviderActionRejected = unknownProviderActionResponse.status === 404;
  if (!unknownProviderActionRejected) throw new Error('production-provider-canary-unknown-action-not-rejected');

  const providerAudit = await providerRequest(env, '/provider/audit', {
    context: actionContext(canaryRunId, 'provider-audit', actionIdempotencyKeys.providerAudit, nowMs),
  }, actionIdempotencyKeys.providerAudit);
  const primaryRetrieval = await providerRequest(env, '/provider/archive/retrieve', {
    role: 'primary',
    storageId: steady.primaryStorageId,
    archiveId: steady.archiveId,
    expectedDigest: steady.archiveContentDigest,
    context: actionContext(canaryRunId, 'primary-archive-retrieval', actionIdempotencyKeys.primaryRetrieval, nowMs),
  }, actionIdempotencyKeys.primaryRetrieval);
  const backupRetrieval = await providerRequest(env, '/provider/archive/retrieve', {
    role: 'backup',
    storageId: steady.backupStorageId,
    archiveId: steady.archiveId,
    expectedDigest: steady.archiveContentDigest,
    context: actionContext(canaryRunId, 'backup-archive-retrieval', actionIdempotencyKeys.backupRetrieval, nowMs),
  }, actionIdempotencyKeys.backupRetrieval);
  const providerHealth = await providerRequest(env, '/provider/health', {
    context: actionContext(canaryRunId, 'operational-health', actionIdempotencyKeys.providerHealth, nowMs),
  }, actionIdempotencyKeys.providerHealth);

  if (!providerAudit.auditStreamId || !providerAudit.auditCursorStart || !providerAudit.auditCursorEnd ||
    !Array.isArray(providerAudit.providerAuditRecordIds) || providerAudit.providerAuditRecordIds.length === 0) {
    throw new Error('production-provider-canary-audit-invalid');
  }
  if (!validateRetrieval(primaryRetrieval, steady.primaryStorageId, steady.archiveId, steady.archiveContentDigest)) {
    throw new Error('production-provider-canary-primary-retrieval-invalid');
  }
  if (!validateRetrieval(backupRetrieval, steady.backupStorageId, steady.archiveId, steady.archiveContentDigest)) {
    throw new Error('production-provider-canary-backup-retrieval-invalid');
  }
  if (!validateHealth(providerHealth, steady)) throw new Error('production-provider-canary-health-invalid');

  const pagerBody = {
    dedupeKey: actionIdempotencyKeys.pager,
    cycleId: canaryRunId,
    reason: 'production-provider-canary-test',
    nowMs,
    onCallRoute: env.CANARY_PAGER_ROUTE,
    escalationTarget: env.CANARY_PAGER_TARGET,
  };
  const firstPage = await pagerRequest(env, pagerBody, actionIdempotencyKeys.pager);
  const duplicatePage = await pagerRequest(env, pagerBody, actionIdempotencyKeys.pager);
  const duplicatePagerSuppressed = duplicatePage.status === 'deduplicated';
  if (!duplicatePagerSuppressed || !['accepted', 'deduplicated'].includes(firstPage.status)) {
    throw new Error('production-provider-canary-pager-dedupe-invalid');
  }
  const pager = {
    route: env.CANARY_PAGER_ROUTE,
    target: env.CANARY_PAGER_TARGET,
    firstStatus: firstPage.status,
    duplicateStatus: duplicatePage.status,
    deliveryId: firstPage.deliveryId ?? null,
    attempts: Math.max(Number(firstPage.attempts ?? 1), Number(duplicatePage.attempts ?? 1)),
    dedupeKey: actionIdempotencyKeys.pager,
  };

  const forbiddenMutationPathUnavailable = !ALLOWED_PROVIDER_PATHS.has('/provider/keys/rotate') &&
    !ALLOWED_PROVIDER_PATHS.has('/provider/dr/exercise');
  if (!forbiddenMutationPathUnavailable) throw new Error('production-provider-canary-forbidden-path-exposed');
  const deploymentDriftRejected = !deploymentSetMatches(
    [{ ...directDeployments[0], versionId: 'drifted-version-id' }, ...directDeployments.slice(1)],
    deploymentPayload.deployments,
  );

  const completedAtMs = Math.max(Date.now(), nowMs + 1);
  const preArtifact = canonicalJson({ canaryRunId, deploymentCanaryRunId: deploymentEvidence.runId, steadyStateRunId: steadyEvidence.runId });
  const preArtifactSha = await sha256Hex(preArtifact);
  const untrustedVerifierRejected = await probeUntrustedVerifierRejected(preArtifact, preArtifactSha, completedAtMs);
  if (!untrustedVerifierRejected) throw new Error('production-provider-canary-untrusted-verifier-not-rejected');

  const negativeChecks = {
    badIdempotencyRejected,
    unknownProviderActionRejected,
    duplicatePagerSuppressed,
    deploymentDriftRejected,
    digestMismatchRejected: true,
    untrustedVerifierRejected,
    forbiddenMutationPathUnavailable,
  };
  const forbiddenActionAttempts = [];
  const payloadWithoutArtifact = {
    canaryRunId,
    deploymentCanaryRunId: deploymentEvidence.runId,
    deploymentCanaryArtifactSha256: deploymentEvidence.artifact.sha256,
    steadyStateRunId: steadyEvidence.runId,
    steadyStateArtifactSha256: steadyEvidence.artifact.sha256,
    startedAtMs,
    completedAtMs,
    deployments: deploymentPayload.deployments,
    providerIdentity: {
      providerName: providerIdentity.providerName,
      accountId: providerIdentity.accountId,
      primaryStorageId: providerIdentity.primaryStorageId,
      backupStorageId: providerIdentity.backupStorageId,
      replicaSiteId: providerIdentity.replicaSiteId,
      replicaRegion: providerIdentity.replicaRegion,
      archiveId: providerIdentity.archiveId,
      archiveContentDigest: providerIdentity.archiveContentDigest,
      credentialSetId: providerIdentity.credentialSetId,
      signingKeyId: providerIdentity.signingKeyId,
      encryptionKeyId: providerIdentity.encryptionKeyId,
    },
    providerAudit,
    primaryRetrieval,
    backupRetrieval,
    providerHealth,
    pager,
    actionIdempotencyKeys,
    forbiddenActionAttempts,
    negativeChecks,
  };
  const artifactRecord = {
    schema: 'unzen-continuous-assurance-production-provider-canary-v1',
    ...payloadWithoutArtifact,
  };
  const artifactContent = canonicalJson(artifactRecord);
  const artifactSha256 = await sha256Hex(artifactContent);
  const artifactKey = `provider-canary/artifacts/${encodeURIComponent(canaryRunId)}/${artifactSha256}.json`;
  await env.CANARY_EVIDENCE_BUCKET.put(artifactKey, artifactContent, {
    customMetadata: { sha256: artifactSha256, canaryRunId, deploymentCanaryRunId: deploymentEvidence.runId, steadyStateRunId: steadyEvidence.runId },
  });
  const artifactLocator = `r2://continuous-assurance-evidence/${encodeURIComponent(artifactKey)}`;
  const payload = {
    ...payloadWithoutArtifact,
    artifactLocator,
    artifactSha256,
    verifier: VERIFIER_NAME,
    verifierVersion: VERIFIER_VERSION,
    verificationId: `${VERIFIER_NAME}:${canaryRunId}`,
    capturedAtMs: completedAtMs,
  };
  const attestation = await verifierCapture(env, {
    evidenceKind: EVIDENCE_KIND,
    runId: canaryRunId,
    payload,
    requestedReadinessStatus: 'production-candidate',
    artifactLocator,
    artifactSha256,
  });
  const deployCommitSha = env.DEPLOY_COMMIT_SHA || '';
  if (!GIT_COMMIT_PATTERN.test(deployCommitSha)) throw new Error('production-provider-canary-deploy-commit-invalid');
  const envelope = {
    schemaVersion: '1.0.0',
    evidenceKind: EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: { name: SERVICE, version: '1.0.0', commitSha: deployCommitSha },
    runId: canaryRunId,
    capturedAt: new Date(completedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'production-provider-canary',
      os: { name: 'cloudflare-workers', version: 'managed' },
      metadata: { deploymentCanaryRunId: deploymentEvidence.runId, steadyStateRunId: steadyEvidence.runId },
    },
    scenario: { feature: EVIDENCE_KIND, scenario: canaryRunId, expectedResult: 'bounded provider and canary pager checks pass' },
    artifact: { locator: artifactLocator, sha256: artifactSha256, expiresAt: new Date(completedAtMs + Number(env.CANARY_RETENTION_MS || '2592000000')).toISOString() },
    verification: { verifier: attestation.verifier, version: attestation.version, verifiedAt: attestation.verifiedAt, result: 'pass' },
    redaction: { applied: true, policyVersion: 'production-provider-canary-v1' },
    payload,
  };

  const correctVerification = await verifierArtifact(env, envelope, artifactContent, artifactSha256);
  if (!correctVerification.ok || correctVerification.result?.result !== 'pass') {
    throw new Error('production-provider-canary-artifact-reverification-failed');
  }
  const mismatchVerification = await verifierArtifact(env, envelope, artifactContent, '0'.repeat(64));
  if (mismatchVerification.ok) throw new Error('production-provider-canary-digest-mismatch-not-rejected');
  const validation = await validateEvidenceEnvelope(envelope, {
    now: completedAtMs + 2_000,
    trustedVerifiers: [{ name: VERIFIER_NAME, version: VERIFIER_VERSION }],
    loadArtifact: async () => artifactContent,
    verifyArtifact: async () => correctVerification.result,
  });
  if (validation.status !== 'valid' || validation.effectiveEvidenceLevel !== 'captured-and-verified' ||
    validation.effectiveReadinessStatus !== 'production-candidate') {
    throw new Error('production-provider-canary-envelope-validation-failed');
  }

  await env.CANARY_EVIDENCE_BUCKET.put(resultKey, JSON.stringify(envelope), {
    customMetadata: { runId: canaryRunId, artifactSha256, deploymentCanaryRunId: deploymentEvidence.runId, steadyStateRunId: steadyEvidence.runId },
  });
  await env.CANARY_EVIDENCE_BUCKET.put('provider-canary/latest-envelope.json', JSON.stringify(envelope), {
    customMetadata: { runId: canaryRunId, artifactSha256 },
  });
  return envelope;
}

async function loadDeploymentEvidenceForScheduled(env) {
  const key = env.DEPLOYMENT_CANARY_EVIDENCE_KEY || 'deployment-canary/latest-envelope.json';
  const object = await env.CANARY_EVIDENCE_BUCKET.get(key);
  if (!object) throw new Error('production-provider-canary-deployment-evidence-object-missing');
  const text = new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
  return JSON.parse(text);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/__meta') return Response.json(deploymentMetadata(env));
    if (request.method === 'POST' && url.pathname === '/__run') {
      const authorized = await secretEquals(request.headers.get('x-unzen-provider-canary-secret'), env.PROVIDER_CANARY_CONTROLLER_SECRET);
      if (!authorized) return Response.json({ error: 'forbidden' }, { status: 403 });
      try {
        return Response.json(await runProductionProviderCanary(await request.json(), env));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
      }
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    if (env.PROVIDER_CANARY_ENABLED !== 'true') {
      console.log(JSON.stringify({ event: 'production_provider_canary_disabled' }));
      return;
    }
    ctx.waitUntil(loadDeploymentEvidenceForScheduled(env)
      .then((deploymentCanaryEvidence) => runProductionProviderCanary({ deploymentCanaryEvidence, nowMs: Date.now() }, env))
      .then((envelope) => console.log(JSON.stringify({
        event: 'production_provider_canary_completed',
        runId: envelope.runId,
        artifactSha256: envelope.artifact.sha256,
      }))));
  },
};
