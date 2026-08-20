import {
  createContinuousAssuranceEvidenceValidationOptions,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.ts';
import {
  createProductionOperationsRolloutPhaseCapture,
  createProductionOperationsDirectEvidenceValidationOptions,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout-controller-service.ts';
import {
  createProductionOperationsRolloutServiceBindingExecutor,
  runProductionOperationsRolloutPhase,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout-runner.ts';

async function secretEquals(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

function parseObject(value, label) {
  try {
    const parsed = JSON.parse(value || '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
    return parsed;
  } catch {
    throw new Error(`production-rollout-${label}-invalid`);
  }
}

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`production-rollout-${label}-invalid`);
  return parsed;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/__run') return new Response('not found', { status: 404 });
    if (!await secretEquals(request.headers.get('x-unzen-rollout-secret'), env.ROLLOUT_CONTROLLER_SECRET)) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }

    try {
      const input = await request.json();
      const nowMs = Date.now();
      const expectedConfigFingerprints = parseObject(env.EXPECTED_CONFIG_FINGERPRINTS_JSON, 'config-fingerprints');
      const deploymentVerifierName = env.DEPLOYMENT_VERIFIER_NAME || 'unzen-independent-evidence-verifier';
      const providerVerifierName = env.PROVIDER_CANARY_VERIFIER_NAME || 'unzen-production-provider-canary-verifier';
      const providerVerifierVersion = env.PROVIDER_CANARY_VERIFIER_VERSION || '1.0.0';
      const rolloutVerifierName = env.ROLLOUT_VERIFIER_NAME || 'unzen-production-rollout-verifier';
      const rolloutVerifierVersion = env.ROLLOUT_VERIFIER_VERSION || '1.0.0';
      const retentionMs = positiveNumber(env.ROLLOUT_RETENTION_MS || '2592000000', 'retention');

      const deploymentValidation = createContinuousAssuranceEvidenceValidationOptions({
        binding: env.EVIDENCE_ADAPTER,
        trustedVerifiers: [{ name: deploymentVerifierName }],
        now: nowMs,
      });
      const providerValidation = createProductionOperationsDirectEvidenceValidationOptions({
        bucket: env.ROLLOUT_EVIDENCE_BUCKET,
        verifier: env.PROVIDER_CANARY_VERIFIER,
        verifierName: providerVerifierName,
        verifierVersion: providerVerifierVersion,
        now: nowMs,
      });
      const phaseValidation = createProductionOperationsDirectEvidenceValidationOptions({
        bucket: env.ROLLOUT_EVIDENCE_BUCKET,
        verifier: env.ROLLOUT_VERIFIER,
        verifierName: rolloutVerifierName,
        verifierVersion: rolloutVerifierVersion,
        now: nowMs,
      });
      const capture = createProductionOperationsRolloutPhaseCapture({
        bucket: env.ROLLOUT_EVIDENCE_BUCKET,
        verifier: env.ROLLOUT_VERIFIER,
        verifierName: rolloutVerifierName,
        verifierVersion: rolloutVerifierVersion,
        producerName: 'unzen-production-rollout-controller',
        producerVersion: env.ROLLOUT_CONTROLLER_VERSION || '1.0.0',
        producerCommitSha: env.EXPECTED_DEPLOY_COMMIT_SHA,
        retentionMs,
      });

      const plan = input.rolloutAuthorization?.phasePlan?.find((item) => item.phase === input.phase);
      const phaseStartedAtMs = Number(input.phaseStartedAtMs);
      if (!plan || !Number.isFinite(phaseStartedAtMs)) throw new Error('production-rollout-phase-input-invalid');
      const isFinal = input.phase === 'steady-state-enabled';
      const obligations = isFinal ? {
        nextCycleDueAtMs: nowMs + positiveNumber(env.ROLLOUT_CYCLE_CADENCE_MS, 'cycle-cadence'),
        nextRotationDueAtMs: nowMs + positiveNumber(env.ROLLOUT_ROTATION_CADENCE_MS, 'rotation-cadence'),
        nextDrExerciseDueAtMs: nowMs + positiveNumber(env.ROLLOUT_DR_CADENCE_MS, 'dr-cadence'),
        evidenceRetentionUntilMs: nowMs + retentionMs,
        onCallRoute: env.ROLLOUT_ONCALL_ROUTE,
        escalationTarget: env.ROLLOUT_ESCALATION_TARGET,
        rollbackControlId: input.rolloutAuthorization.rollbackControlId,
        emergencyHoldControlId: input.rolloutAuthorization.emergencyHoldControlId,
      } : undefined;

      const result = await runProductionOperationsRolloutPhase({
        phase: input.phase,
        previousPhaseEvidences: Array.isArray(input.previousPhaseEvidences) ? input.previousPhaseEvidences : [],
        phaseStartedAtMs,
        nowMs,
        replayCount: Number(input.replayCount || 0),
        minimumProviderAvailabilityPct: positiveNumber(env.ROLLOUT_MIN_PROVIDER_AVAILABILITY_PCT, 'availability-threshold'),
        allowedFailureBudget: positiveNumber(env.ROLLOUT_ALLOWED_FAILURE_BUDGET, 'failure-budget'),
        providerCanaryEvidence: input.providerCanaryEvidence,
        rolloutAuthorization: input.rolloutAuthorization,
        executor: createProductionOperationsRolloutServiceBindingExecutor({
          provider: env.PROVIDER_ADAPTER,
          evidence: env.EVIDENCE_ADAPTER,
          pager: env.PAGER_ADAPTER,
        }),
        capture,
        steadyStateObligations: obligations,
        onCallRoute: env.ROLLOUT_ONCALL_ROUTE,
        escalationTarget: env.ROLLOUT_ESCALATION_TARGET,
        evidenceValidationOptions: providerValidation,
        deploymentEvidenceValidationOptions: deploymentValidation,
        phaseEvidenceValidationOptions: phaseValidation,
        expectedDeployCommitSha: env.EXPECTED_DEPLOY_COMMIT_SHA,
        expectedDeploymentManifestSha256: env.EXPECTED_DEPLOYMENT_MANIFEST_SHA256,
        expectedConfigFingerprints,
        expectedVerifierName: providerVerifierName,
        expectedDeploymentVerifierName: deploymentVerifierName,
        expectedPhaseVerifierName: rolloutVerifierName,
      });
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    }
  },
};
