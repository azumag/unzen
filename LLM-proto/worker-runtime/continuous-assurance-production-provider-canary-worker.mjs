import {
  createContinuousAssuranceEvidenceValidationOptions,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.ts';
import {
  runProductionProviderCanaryController,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary-controller-service.ts';

const DEFAULT_DEPLOYMENT_VERIFIER = 'unzen-independent-evidence-verifier';

async function secretEquals(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

function parseJson(value, label) {
  try {
    const parsed = JSON.parse(value || '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
    return parsed;
  } catch {
    throw new Error(`production-provider-canary-${label}-invalid`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/__run') {
      return new Response('not found', { status: 404 });
    }
    const authorized = await secretEquals(
      request.headers.get('x-unzen-provider-canary-secret'),
      env.PROVIDER_CANARY_CONTROLLER_SECRET,
    );
    if (!authorized) return Response.json({ error: 'forbidden' }, { status: 403 });

    try {
      const input = await request.json();
      const nowMs = Number(input.nowMs ?? Date.now());
      const expectedConfigFingerprints = parseJson(env.EXPECTED_CONFIG_FINGERPRINTS_JSON, 'config-fingerprints');
      const deploymentVerifierName = env.DEPLOYMENT_VERIFIER_NAME || DEFAULT_DEPLOYMENT_VERIFIER;
      const deploymentEvidenceValidationOptions = createContinuousAssuranceEvidenceValidationOptions({
        binding: env.EVIDENCE_ADAPTER,
        trustedVerifiers: [{ name: deploymentVerifierName }],
        now: nowMs,
      });

      const envelope = await runProductionProviderCanaryController({
        canaryRunId: input.canaryRunId,
        nowMs,
        deploymentCanaryEvidence: input.deploymentCanaryEvidence,
        deploymentEvidenceValidationOptions,
        expectedDeployCommitSha: env.EXPECTED_DEPLOY_COMMIT_SHA,
        expectedDeploymentManifestSha256: env.EXPECTED_DEPLOYMENT_MANIFEST_SHA256,
        expectedConfigFingerprints,
        expectedDeploymentVerifierName: deploymentVerifierName,
        authorization: input.authorization,
        bindings: {
          provider: env.PROVIDER_ADAPTER,
          pager: env.PAGER_ADAPTER,
        },
        verifier: env.PROVIDER_CANARY_VERIFIER,
        bucket: env.CANARY_EVIDENCE_BUCKET,
        verifierName: env.PROVIDER_CANARY_VERIFIER_NAME,
        verifierVersion: env.PROVIDER_CANARY_VERIFIER_VERSION,
        producerName: 'unzen-production-provider-canary-controller',
        producerVersion: env.PROVIDER_CANARY_CONTROLLER_VERSION || '1.0.0',
        producerCommitSha: env.EXPECTED_DEPLOY_COMMIT_SHA,
        retentionMs: Number(env.PROVIDER_CANARY_RETENTION_MS || '2592000000'),
        onCallRoute: env.PROVIDER_CANARY_ONCALL_ROUTE,
        escalationTarget: env.PROVIDER_CANARY_ESCALATION_TARGET,
      });
      return Response.json(envelope);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
    }
  },
};
