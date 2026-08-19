import baseVerifier from './continuous-assurance-independent-verifier-worker.mjs';

const EVIDENCE_KIND = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function numberValue(value) {
  return Number.isFinite(value) ? value : undefined;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

async function sha256Hex(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function artifactBytes(value) {
  if (!isRecord(value)) throw new Error('artifact-content-invalid');
  if (value.kind === 'utf8' && typeof value.content === 'string') return new TextEncoder().encode(value.content);
  if (value.kind === 'bytes' && Array.isArray(value.bytes) && value.bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return new Uint8Array(value.bytes);
  }
  throw new Error('artifact-content-invalid');
}

function failed(env, reason, runId = '') {
  return {
    verifier: env.VERIFIER_NAME,
    version: env.VERIFIER_VERSION,
    verifiedAt: new Date(0).toISOString(),
    result: 'fail',
    reason,
    evidenceKind: EVIDENCE_KIND,
    ...(runId ? { runId } : {}),
    readinessStatus: 'contract-tested',
  };
}

function validatePayload(payload, runId) {
  if (!isRecord(payload) || payload.canaryRunId !== runId) return 'provider-canary-run-identity-invalid';
  if (!stringValue(payload.deploymentCanaryRunId) || !SHA256_PATTERN.test(stringValue(payload.deploymentCanaryArtifactSha256)) ||
    !stringValue(payload.steadyStateRunId) || !SHA256_PATTERN.test(stringValue(payload.steadyStateArtifactSha256))) {
    return 'provider-canary-upstream-identity-invalid';
  }
  if (!Array.isArray(payload.deployments) || payload.deployments.length !== 7) return 'provider-canary-deployment-set-invalid';
  const versionIds = new Set();
  for (const deployment of payload.deployments) {
    if (!isRecord(deployment) || !stringValue(deployment.role) || !stringValue(deployment.service) ||
      stringValue(deployment.versionId).length < 8 || !SHA256_PATTERN.test(stringValue(deployment.configFingerprintSha256))) {
      return 'provider-canary-deployment-identity-invalid';
    }
    if (versionIds.has(deployment.versionId)) return 'provider-canary-deployment-version-duplicate';
    versionIds.add(deployment.versionId);
  }
  const identity = payload.providerIdentity;
  if (!isRecord(identity) || !stringValue(identity.providerName) || !stringValue(identity.accountId) ||
    !stringValue(identity.primaryStorageId) || !stringValue(identity.backupStorageId) ||
    !stringValue(identity.archiveId) || !SHA256_PATTERN.test(stringValue(identity.archiveContentDigest)) ||
    !stringValue(identity.credentialSetId) || !stringValue(identity.signingKeyId) || !stringValue(identity.encryptionKeyId)) {
    return 'provider-canary-provider-identity-invalid';
  }
  const audit = payload.providerAudit;
  if (!isRecord(audit) || !stringValue(audit.auditStreamId) || !stringValue(audit.auditCursorStart) ||
    !stringValue(audit.auditCursorEnd) || !Array.isArray(audit.providerAuditRecordIds) || audit.providerAuditRecordIds.length === 0 ||
    numberValue(audit.observedAtMs) === undefined) {
    return 'provider-canary-audit-invalid';
  }
  for (const [label, retrieval, storageId] of [
    ['primary', payload.primaryRetrieval, identity.primaryStorageId],
    ['backup', payload.backupRetrieval, identity.backupStorageId],
  ]) {
    if (!isRecord(retrieval) || retrieval.storageId !== storageId || retrieval.archiveId !== identity.archiveId ||
      retrieval.observedContentDigest !== identity.archiveContentDigest || retrieval.integrityStatus !== 'pass' ||
      !stringValue(retrieval.retrievalOperationId) || !stringValue(retrieval.integrityCheckId)) {
      return `provider-canary-${label}-retrieval-invalid`;
    }
  }
  const health = payload.providerHealth;
  if (!isRecord(health) || numberValue(health.failureCount) !== 0 || numberValue(health.rtoBreachCount) !== 0 ||
    numberValue(health.rpoBreachCount) !== 0 || numberValue(health.integrityFailureCount) !== 0 ||
    health.observedCredentialSetId !== identity.credentialSetId || health.observedSigningKeyId !== identity.signingKeyId ||
    health.observedEncryptionKeyId !== identity.encryptionKeyId || health.rollbackArmed !== true || health.emergencyHoldArmed !== true) {
    return 'provider-canary-health-invalid';
  }
  const pager = payload.pager;
  if (!isRecord(pager) || !stringValue(pager.route) || !stringValue(pager.target) || !stringValue(pager.dedupeKey) ||
    !['accepted', 'deduplicated'].includes(pager.firstStatus) || pager.duplicateStatus !== 'deduplicated') {
    return 'provider-canary-pager-invalid';
  }
  if (!isRecord(payload.actionIdempotencyKeys) || Object.values(payload.actionIdempotencyKeys).length !== 5 ||
    new Set(Object.values(payload.actionIdempotencyKeys)).size !== 5) {
    return 'provider-canary-idempotency-invalid';
  }
  if (!Array.isArray(payload.forbiddenActionAttempts) || payload.forbiddenActionAttempts.length !== 0) {
    return 'provider-canary-forbidden-action-attempted';
  }
  if (!isRecord(payload.negativeChecks) || !Object.values(payload.negativeChecks).every((value) => value === true)) {
    return 'provider-canary-negative-check-incomplete';
  }
  if (!stringValue(payload.artifactLocator) || !SHA256_PATTERN.test(stringValue(payload.artifactSha256)) ||
    !stringValue(payload.verifier) || !stringValue(payload.verifierVersion) || !stringValue(payload.verificationId) ||
    numberValue(payload.capturedAtMs) === undefined) {
    return 'provider-canary-artifact-invalid';
  }
  return undefined;
}

function validateArtifactBinding(bytes, payload, runId) {
  let record;
  try {
    record = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return 'provider-canary-artifact-json-invalid';
  }
  if (!isRecord(record) || record.schema !== 'unzen-continuous-assurance-production-provider-canary-v1') {
    return 'provider-canary-artifact-schema-invalid';
  }
  const fields = [
    'canaryRunId', 'deploymentCanaryRunId', 'deploymentCanaryArtifactSha256',
    'steadyStateRunId', 'steadyStateArtifactSha256', 'startedAtMs', 'completedAtMs',
  ];
  for (const field of fields) if (record[field] !== payload[field]) return `provider-canary-artifact-identity-mismatch:${field}`;
  if (record.canaryRunId !== runId) return 'provider-canary-artifact-run-mismatch';
  for (const field of [
    'deployments', 'providerIdentity', 'providerAudit', 'primaryRetrieval', 'backupRetrieval',
    'providerHealth', 'pager', 'actionIdempotencyKeys', 'forbiddenActionAttempts', 'negativeChecks',
  ]) {
    if (stableJson(record[field]) !== stableJson(payload[field])) return `provider-canary-artifact-payload-mismatch:${field}`;
  }
  return undefined;
}

async function handleProviderCanary(request, env, body, path) {
  const runId = path === '/verify/artifact' ? stringValue(body?.envelope?.runId) : stringValue(body?.runId);
  const payload = path === '/verify/artifact' ? body?.envelope?.payload : body?.payload;
  if (!runId || !isRecord(payload)) return Response.json(failed(env, 'provider-canary-request-invalid', runId), { status: 409 });
  if (path === '/verify/capture') {
    if (body.requestedReadinessStatus !== 'production-candidate' || !SHA256_PATTERN.test(stringValue(body.artifactSha256))) {
      return Response.json(failed(env, 'provider-canary-capture-request-invalid', runId), { status: 409 });
    }
    const reason = validatePayload(payload, runId);
    if (reason) return Response.json(failed(env, reason, runId), { status: 409 });
    return Response.json({
      verifier: env.VERIFIER_NAME,
      version: env.VERIFIER_VERSION,
      verifiedAt: new Date(payload.capturedAtMs + 1_000).toISOString(),
      result: 'pass',
      evidenceKind: EVIDENCE_KIND,
      runId,
      readinessStatus: 'production-candidate',
    });
  }
  if (path === '/verify/artifact') {
    const envelope = body.envelope;
    if (envelope?.evidenceKind !== EVIDENCE_KIND || envelope?.readinessStatus !== 'production-candidate') {
      return Response.json(failed(env, 'provider-canary-envelope-kind-invalid', runId), { status: 409 });
    }
    const bytes = artifactBytes(body.artifactContent);
    const actual = await sha256Hex(bytes);
    const expected = stringValue(envelope.artifact?.sha256);
    if (!SHA256_PATTERN.test(stringValue(body.actualSha256)) || actual !== body.actualSha256 || actual !== expected) {
      return Response.json(failed(env, 'provider-canary-artifact-digest-mismatch', runId), { status: 409 });
    }
    const reason = validatePayload(payload, runId) || validateArtifactBinding(bytes, payload, runId);
    if (reason) return Response.json(failed(env, reason, runId), { status: 409 });
    const verifiedAt = new Date(payload.capturedAtMs + 1_000).toISOString();
    if (!isRecord(envelope.verification) || envelope.verification.verifier !== env.VERIFIER_NAME ||
      envelope.verification.version !== env.VERIFIER_VERSION || envelope.verification.verifiedAt !== verifiedAt ||
      envelope.verification.result !== 'pass') {
      return Response.json(failed(env, 'provider-canary-envelope-attestation-invalid', runId), { status: 409 });
    }
    return Response.json({ verifier: env.VERIFIER_NAME, version: env.VERIFIER_VERSION, verifiedAt, result: 'pass' });
  }
  return new Response('not found', { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && (url.pathname === '/verify/capture' || url.pathname === '/verify/artifact')) {
      try {
        const body = await request.clone().json();
        const evidenceKind = url.pathname === '/verify/artifact' ? body?.envelope?.evidenceKind : body?.evidenceKind;
        if (evidenceKind === EVIDENCE_KIND) return handleProviderCanary(request, env, body, url.pathname);
      } catch {
        // base verifier owns malformed-request behavior for non-provider-canary traffic.
      }
    }
    return baseVerifier.fetch(request, env, ctx);
  },
};
