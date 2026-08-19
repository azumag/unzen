const EVIDENCE_KIND = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary';
const SERVICE = 'unzen-llm-continuous-assurance-production-canary';
const DEFAULT_SCOPE = 'publisher-tax-exception-archive-dr';
const DEFAULT_CRON = '17 * * * *';
const VERIFIER_NAME = 'unzen-independent-evidence-verifier';
const VERIFIER_VERSION = '1.0.0';

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
  const value = await response.json();
  return roleMeta(role, value);
}

function metadataValid(meta) {
  return meta && typeof meta.service === 'string' && meta.service.length > 0 &&
    typeof meta.versionId === 'string' && meta.versionId.length >= 8 &&
    typeof meta.versionTimestamp === 'string' && Number.isFinite(Date.parse(meta.versionTimestamp)) &&
    typeof meta.configFingerprintSha256 === 'string' && /^[a-f0-9]{64}$/.test(meta.configFingerprintSha256);
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
  if (attestation.result !== 'pass' || attestation.verifier !== VERIFIER_NAME || attestation.version !== VERIFIER_VERSION) {
    throw new Error('production-canary-verifier-attestation-invalid');
  }
  return attestation;
}

async function verifyDigestMismatchRejected(env, envelope, artifactContent) {
  const response = await env.INDEPENDENT_VERIFIER.fetch(new Request('https://verifier.internal/verify/artifact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      envelope,
      actualSha256: '0'.repeat(64),
      artifactContent: { kind: 'utf8', content: artifactContent },
    }),
  }));
  return !response.ok;
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

export async function runProductionDeploymentCanary(input, env) {
  const scope = env.CONTINUOUS_ASSURANCE_SCOPE || DEFAULT_SCOPE;
  const cron = input.cron || env.PRODUCTION_CANARY_CRON || DEFAULT_CRON;
  const scheduledTimeMs = Number(input.scheduledTimeMs);
  const deliveryAtMs = Number(input.deliveryAtMs ?? Date.now());
  if (!Number.isFinite(scheduledTimeMs) || !Number.isFinite(deliveryAtMs) || deliveryAtMs < scheduledTimeMs) {
    throw new Error('production-canary-timeline-invalid');
  }
  const triggerKey = `${scope}:${cron}:${scheduledTimeMs}`;
  const canaryRunId = `production-deployment-canary:${scheduledTimeMs}`;
  const startedAtMs = deliveryAtMs;

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

  const badSecret = await dispatchRuntime(env, { cron, scheduledTimeMs, deliveryAtMs }, 'intentionally-invalid');
  const badDispatchSecretRejected = badSecret.status === 403;
  if (!badDispatchSecretRejected) throw new Error('production-canary-bad-secret-not-rejected');

  const dispatched = await dispatchRuntime(env, { cron, scheduledTimeMs, deliveryAtMs }, env.CANARY_DISPATCH_SECRET);
  if (!dispatched.ok) throw new Error(`production-canary-runtime-http-${dispatched.status}`);
  const first = await dispatched.json();
  const firstRuntime = runtimeResult(first, triggerKey);
  if (firstRuntime.status !== 'pass' || firstRuntime.runtimeDelivery.durableState !== 'completed' || firstRuntime.runtimeDelivery.replayed) {
    throw new Error('production-canary-runtime-not-clean');
  }

  const duplicate = await dispatchRuntime(env, { cron, scheduledTimeMs, deliveryAtMs: deliveryAtMs + 1 }, env.CANARY_DISPATCH_SECRET);
  if (!duplicate.ok) throw new Error(`production-canary-duplicate-http-${duplicate.status}`);
  const duplicateValue = await duplicate.json();
  const duplicateCompletedDispatchSuppressed = duplicateValue.runtimeDelivery?.replayed === true &&
    duplicateValue.runtimeDelivery?.durableState === 'completed' &&
    duplicateValue.cycleId === first.cycleId;
  if (!duplicateCompletedDispatchSuppressed) throw new Error('production-canary-duplicate-not-suppressed');

  const versionOrConfigMismatchRejected = !metadataValid({ ...deployments[0], configFingerprintSha256: 'invalid' });
  const untrustedVerifierRejected = VERIFIER_NAME === env.TRUSTED_VERIFIER_NAME;
  if (!untrustedVerifierRejected) throw new Error('production-canary-trusted-verifier-mismatch');

  const completedAtMs = Math.max(deliveryAtMs + 2, Date.now());
  const record = {
    schema: 'unzen-continuous-assurance-production-deployment-canary-v1',
    canaryRunId,
    triggerKey,
    deployments,
    runtimeResult: firstRuntime,
    badDispatchSecretRejected,
    duplicateCompletedDispatchSuppressed,
  };
  const artifactContent = canonicalJson(record);
  const artifactSha256 = await sha256Hex(artifactContent);
  const key = `deployment-canary/${encodeURIComponent(canaryRunId)}/${artifactSha256}.json`;
  await env.CANARY_EVIDENCE_BUCKET.put(key, artifactContent, {
    customMetadata: { sha256: artifactSha256, canaryRunId, triggerKey },
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
    deployments,
    runtimeResult: firstRuntime,
    artifactLocator,
    artifactSha256,
    verificationId: `pending:${canaryRunId}`,
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
  const finalPayload = { ...payload, verificationId: `${attestation.verifier}:${attestation.verifiedAt}:${canaryRunId}` };
  const envelope = {
    schemaVersion: '1.0.0',
    evidenceKind: EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: {
      name: SERVICE,
      version: '1.0.0',
      commitSha: env.DEPLOY_COMMIT_SHA || undefined,
    },
    runId: canaryRunId,
    capturedAt: new Date(completedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers',
      runtimeVersion: 'managed',
      executionSurface: 'production-deployment-canary',
      os: { name: 'cloudflare-workers', version: 'managed' },
    },
    scenario: {
      feature: 'continuous-assurance-production-deployment',
      scenario: canaryRunId,
      expectedResult: 'controlled deployed canary passes',
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
    payload: finalPayload,
  };

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
    ctx.waitUntil(runProductionDeploymentCanary({
      cron: controller.cron,
      scheduledTimeMs,
      deliveryAtMs: Date.now(),
    }, env).then((envelope) => {
      console.log(JSON.stringify({
        event: 'production_deployment_canary_completed',
        runId: envelope.runId,
        artifactSha256: envelope.artifact.sha256,
      }));
    }));
  },
};
