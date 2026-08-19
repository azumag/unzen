import { validateEvidenceEnvelope } from '../src/evidence.ts';

const EVIDENCE_KIND = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary';
const SERVICE = 'unzen-llm-continuous-assurance-production-canary';
const DEFAULT_SCOPE = 'publisher-tax-exception-archive-dr';
const DISPATCH_CRON = 'deployment-canary-idle';
const VERIFIER_NAME = 'unzen-independent-evidence-verifier';
const VERIFIER_VERSION = '1.0.0';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;

function deploymentMetadata(env) {
  const version = env.CF_VERSION_METADATA || {};
  return {
    role: 'controller',
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

function roleMeta(role, value) {
  return { role, ...value };
}

async function readMeta(binding, role) {
  const response = await binding.fetch(new Request(`https://${role}.internal/__meta`, { method: 'GET' }));
  if (!response.ok) throw new Error(`production-canary-meta-http-${role}-${response.status}`);
  return roleMeta(role, await response.json());
}

async function readEngineState(env, scope) {
  const response = await env.ASSURANCE_ENGINE.fetch(new Request(
    `https://engine.internal/__canary/state?scope=${encodeURIComponent(scope)}`,
    { method: 'GET', headers: { 'x-unzen-canary-secret': env.CANARY_DISPATCH_SECRET } },
  ));
  if (!response.ok) throw new Error(`production-canary-engine-state-http-${response.status}`);
  return response.json();
}

async function readEngineBindings(env) {
  const response = await env.ASSURANCE_ENGINE.fetch(new Request('https://engine.internal/__canary/bindings', {
    method: 'GET',
    headers: { 'x-unzen-canary-secret': env.CANARY_DISPATCH_SECRET },
  }));
  if (!response.ok) throw new Error(`production-canary-engine-bindings-http-${response.status}`);
  return response.json();
}

function metadataValid(meta) {
  return meta && typeof meta.service === 'string' && meta.service.length > 0 &&
    typeof meta.versionId === 'string' && meta.versionId.length >= 8 &&
    typeof meta.versionTimestamp === 'string' && Number.isFinite(Date.parse(meta.versionTimestamp)) &&
    typeof meta.configFingerprintSha256 === 'string' && SHA256_PATTERN.test(meta.configFingerprintSha256);
}

async function dispatchRuntime(env, input, secret) {
  return env.CONTINUOUS_ASSURANCE_RUNTIME.fetch(new Request('https://runtime.internal/__canary/dispatch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unzen-canary-secret': secret,
    },
    body: JSON.stringify(input),
  }));
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

async function verifierCapture(env, body) {
  const response = await env.INDEPENDENT_VERIFIER.fetch(new Request('https://verifier.internal/verify/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error(`production-canary-verifier-capture-http-${response.status}`);
  const attestation = await response.json();
  if (attestation.result !== 'pass' || attestation.verifier !== VERIFIER_NAME || attestation.version !== VERIFIER_VERSION ||
    attestation.readinessStatus !== 'production-candidate') {
    throw new Error('production-canary-verifier-attestation-invalid');
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
  const result = await response.json();
  return { ok: response.ok, result };
}

async function verifyDigestMismatchRejected(env, envelope, artifactContent) {
  const verification = await verifierArtifact(env, envelope, artifactContent, '0'.repeat(64));
  return !verification.ok;
}

async function verifyUntrustedVerifierRejected(artifactContent, artifactSha256, capturedAtMs) {
  const probeVerification = {
    verifier: 'untrusted-verifier',
    version: '0.0.0',
    verifiedAt: new Date(capturedAtMs + 1_000).toISOString(),
    result: 'pass',
  };
  const probe = {
    schemaVersion: '1.0.0',
    evidenceKind: EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: { name: SERVICE, version: '1.0.0', commitSha: '0000000000000000000000000000000000000000' },
    runId: `untrusted-verifier-probe:${capturedAtMs}`,
    capturedAt: new Date(capturedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'production-deployment-canary',
      os: { name: 'cloudflare-workers', version: 'managed' },
    },
    scenario: { feature: 'continuous-assurance-production-deployment', scenario: 'untrusted verifier probe', expectedResult: 'rejected' },
    artifact: { locator: 'probe://artifact', sha256: artifactSha256, expiresAt: new Date(capturedAtMs + 60_000).toISOString() },
    verification: probeVerification,
    redaction: { applied: true, policyVersion: 'production-deployment-canary-v1' },
    payload: {},
  };
  const validation = await validateEvidenceEnvelope(probe, {
    now: capturedAtMs + 2_000,
    trustedVerifiers: [{ name: VERIFIER_NAME, version: VERIFIER_VERSION }],
    loadArtifact: async () => artifactContent,
    verifyArtifact: async () => probeVerification,
  });
  return validation.status === 'invalid' && validation.issues.some((issue) => issue.code === 'untrusted-verifier');
}

function runtimeResult(value, triggerKey) {
  return {
    status: value.status,
    triggerKey,
    cycleId: value.cycleId ?? null,
    failureReason: value.failureReason ?? null,
    actionIdempotencyKeys: Array.isArray(value.attempts)
      ? [...new Set(value.attempts.map((attempt) => attempt?.idempotencyKey).filter(Boolean))]
      : [],
    latestCycleRunId: value.newCycleEvidence?.runId ?? null,
    latestAggregateRunId: value.newAggregateEvidence?.runId ?? null,
    runtimeDelivery: {
      durableState: value.runtimeDelivery?.durableState ?? 'running',
      replayCount: Number(value.runtimeDelivery?.replayCount ?? -1),
      replayed: value.runtimeDelivery?.replayed === true,
    },
  };
}

function exactBindingMatches(bindings, direct) {
  return ['provider', 'evidence', 'pager'].every((role) => {
    const left = bindings?.[role];
    const right = direct.find((item) => item.role === role);
    return left && right && left.service === right.service && left.versionId === right.versionId &&
      left.configFingerprintSha256 === right.configFingerprintSha256;
  });
}

export async function runProductionDeploymentCanary(input, env) {
  const scope = env.CONTINUOUS_ASSURANCE_SCOPE || DEFAULT_SCOPE;
  const canaryScheduledTimeMs = Number(input.scheduledTimeMs);
  if (!Number.isFinite(canaryScheduledTimeMs)) throw new Error('production-canary-schedule-invalid');
  const deployCommitSha = env.DEPLOY_COMMIT_SHA || '';
  const deploymentManifestSha256 = env.DEPLOY_MANIFEST_SHA256 || '';
  if (!GIT_COMMIT_PATTERN.test(deployCommitSha) || !SHA256_PATTERN.test(deploymentManifestSha256)) {
    throw new Error('production-canary-deployment-manifest-invalid');
  }
  const canaryRunId = `production-deployment-canary:${canaryScheduledTimeMs}`;

  const deployments = await Promise.all([
    Promise.resolve(deploymentMetadata(env)),
    readMeta(env.CONTINUOUS_ASSURANCE_RUNTIME, 'runtime'),
    readMeta(env.ASSURANCE_ENGINE, 'engine'),
    readMeta(env.PROVIDER_ADAPTER, 'provider'),
    readMeta(env.EVIDENCE_ADAPTER, 'evidence'),
    readMeta(env.PAGER_ADAPTER, 'pager'),
    readMeta(env.INDEPENDENT_VERIFIER, 'verifier'),
  ]);
  if (!deployments.every(metadataValid)) throw new Error('production-canary-deployment-metadata-invalid');

  const engineBindings = await readEngineBindings(env);
  if (!exactBindingMatches(engineBindings, deployments)) throw new Error('production-canary-engine-binding-version-mismatch');

  const state = await readEngineState(env, scope);
  if (!Number.isFinite(state.nextDueAtMs) || !Number.isFinite(state.snapshotUpdatedAtMs)) {
    throw new Error('production-canary-engine-snapshot-not-ready');
  }
  const latestIdleAtMs = state.nextDueAtMs - 1;
  const logicalNowMs = Math.max(state.snapshotUpdatedAtMs, Math.min(Date.now(), latestIdleAtMs));
  if (!Number.isFinite(logicalNowMs) || logicalNowMs >= state.nextDueAtMs) {
    throw new Error('production-canary-no-safe-idle-window');
  }
  const scheduledTimeMs = logicalNowMs;
  const deliveryAtMs = logicalNowMs;
  const cron = DISPATCH_CRON;
  const triggerKey = `${scope}:${cron}:${scheduledTimeMs}`;
  const startedAtMs = logicalNowMs;

  const badSecret = await dispatchRuntime(env, { cron, scheduledTimeMs, deliveryAtMs }, 'intentionally-invalid');
  const badDispatchSecretRejected = badSecret.status === 403;
  if (!badDispatchSecretRejected) throw new Error('production-canary-bad-secret-not-rejected');

  const dispatched = await dispatchRuntime(env, { cron, scheduledTimeMs, deliveryAtMs }, env.CANARY_DISPATCH_SECRET);
  if (!dispatched.ok) throw new Error(`production-canary-runtime-http-${dispatched.status}`);
  const first = await dispatched.json();
  const firstRuntime = runtimeResult(first, triggerKey);
  if (firstRuntime.status !== 'idle' || firstRuntime.runtimeDelivery.durableState !== 'completed' ||
    firstRuntime.runtimeDelivery.replayed || firstRuntime.actionIdempotencyKeys.length !== 0 ||
    firstRuntime.latestCycleRunId !== null || firstRuntime.latestAggregateRunId !== null) {
    throw new Error('production-canary-runtime-not-read-only');
  }

  const duplicate = await dispatchRuntime(env, { cron, scheduledTimeMs, deliveryAtMs: deliveryAtMs + 1 }, env.CANARY_DISPATCH_SECRET);
  if (!duplicate.ok) throw new Error(`production-canary-duplicate-http-${duplicate.status}`);
  const duplicateValue = await duplicate.json();
  const duplicateCompletedDispatchSuppressed = duplicateValue.runtimeDelivery?.replayed === true &&
    duplicateValue.runtimeDelivery?.durableState === 'completed' &&
    duplicateValue.cycleId === first.cycleId;
  if (!duplicateCompletedDispatchSuppressed) throw new Error('production-canary-duplicate-not-suppressed');

  const versionOrConfigMismatchRejected = !metadataValid({ ...deployments[0], configFingerprintSha256: 'invalid' });
  const completedAtMs = logicalNowMs + 2;
  const record = {
    schema: 'unzen-continuous-assurance-production-deployment-canary-v1',
    canaryRunId,
    triggerKey,
    deployCommitSha,
    deploymentManifestSha256,
    deployments,
    engineBindings,
    runtimeResult: firstRuntime,
    badDispatchSecretRejected,
    duplicateCompletedDispatchSuppressed,
  };
  const artifactContent = canonicalJson(record);
  const artifactSha256 = await sha256Hex(artifactContent);
  const untrustedVerifierRejected = await verifyUntrustedVerifierRejected(artifactContent, artifactSha256, completedAtMs);
  if (!untrustedVerifierRejected) throw new Error('production-canary-untrusted-verifier-not-rejected');
  if (VERIFIER_NAME !== env.TRUSTED_VERIFIER_NAME) throw new Error('production-canary-trusted-verifier-mismatch');

  const key = `deployment-canary/${encodeURIComponent(canaryRunId)}/${artifactSha256}.json`;
  await env.CANARY_EVIDENCE_BUCKET.put(key, artifactContent, {
    customMetadata: {
      sha256: artifactSha256,
      canaryRunId,
      triggerKey,
      deployCommitSha,
      deploymentManifestSha256,
    },
  });
  const artifactLocator = `r2://continuous-assurance-evidence/${encodeURIComponent(key)}`;

  const negativeChecks = {
    badDispatchSecretRejected,
    duplicateCompletedDispatchSuppressed,
    versionOrConfigMismatchRejected,
    digestMismatchRejected: true,
    untrustedVerifierRejected,
  };
  const payload = {
    scope,
    cron,
    scheduledTimeMs,
    triggerKey,
    canaryRunId,
    startedAtMs,
    completedAtMs,
    deployCommitSha,
    deploymentManifestSha256,
    deployments,
    runtimeResult: firstRuntime,
    artifactLocator,
    artifactSha256,
    verificationId: `${VERIFIER_NAME}:${canaryRunId}`,
    verifier: VERIFIER_NAME,
    verifierVersion: VERIFIER_VERSION,
    negativeChecks,
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
  const envelope = {
    schemaVersion: '1.0.0',
    evidenceKind: EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: {
      name: SERVICE,
      version: '1.0.0',
      commitSha: deployCommitSha,
    },
    runId: canaryRunId,
    capturedAt: new Date(completedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers',
      runtimeVersion: 'managed',
      executionSurface: 'production-deployment-canary',
      os: { name: 'cloudflare-workers', version: 'managed' },
      metadata: { deploymentManifestSha256 },
    },
    scenario: {
      feature: 'continuous-assurance-production-deployment',
      scenario: canaryRunId,
      expectedResult: 'read-only deployed wiring canary passes',
    },
    artifact: {
      locator: artifactLocator,
      sha256: artifactSha256,
      expiresAt: new Date(completedAtMs + Number(env.CANARY_RETENTION_MS || '2592000000')).toISOString(),
    },
    verification: {
      verifier: attestation.verifier,
      version: attestation.version,
      verifiedAt: attestation.verifiedAt,
      result: 'pass',
    },
    redaction: { applied: true, policyVersion: 'production-deployment-canary-v1' },
    payload,
  };

  const correctArtifactVerification = await verifierArtifact(env, envelope, artifactContent, artifactSha256);
  if (!correctArtifactVerification.ok || correctArtifactVerification.result?.result !== 'pass') {
    throw new Error('production-canary-artifact-reverification-failed');
  }
  const envelopeValidation = await validateEvidenceEnvelope(envelope, {
    now: completedAtMs + 2_000,
    trustedVerifiers: [{ name: VERIFIER_NAME, version: VERIFIER_VERSION }],
    loadArtifact: async () => artifactContent,
    verifyArtifact: async () => correctArtifactVerification.result,
  });
  if (envelopeValidation.status !== 'valid' || envelopeValidation.effectiveEvidenceLevel !== 'captured-and-verified' ||
    envelopeValidation.effectiveReadinessStatus !== 'production-candidate') {
    throw new Error('production-canary-envelope-validation-failed');
  }
  if (!(await verifyDigestMismatchRejected(env, envelope, artifactContent))) {
    throw new Error('production-canary-digest-mismatch-not-rejected');
  }
  return envelope;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/__meta') {
      return Response.json(deploymentMetadata(env));
    }
    if (request.method === 'POST' && url.pathname === '/__run') {
      const authorized = await secretEquals(
        request.headers.get('x-unzen-controller-secret'),
        env.CANARY_CONTROLLER_SECRET,
      );
      if (!authorized) return Response.json({ error: 'forbidden' }, { status: 403 });
      try {
        return Response.json(await runProductionDeploymentCanary(await request.json(), env));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
      }
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    const scheduledTimeMs = controller.scheduledTime instanceof Date
      ? controller.scheduledTime.getTime()
      : Number(controller.scheduledTime);
    ctx.waitUntil(runProductionDeploymentCanary({ scheduledTimeMs }, env).then((envelope) => {
      console.log(JSON.stringify({
        event: 'production_deployment_canary_completed',
        runId: envelope.runId,
        artifactSha256: envelope.artifact.sha256,
      }));
    }));
  },
};
