import { handleContinuousAssuranceEvidenceAdapterRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.ts';

export default {
  async fetch(request, env) {
    return handleContinuousAssuranceEvidenceAdapterRequest(request, {
      bucket: env.EVIDENCE_BUCKET,
      verifier: env.INDEPENDENT_VERIFIER,
      producerName: env.EVIDENCE_PRODUCER_NAME,
      producerVersion: env.EVIDENCE_PRODUCER_VERSION,
      producerCommitSha: env.EVIDENCE_PRODUCER_COMMIT_SHA,
      verifierName: env.TRUSTED_VERIFIER_NAME,
      verifierVersion: env.TRUSTED_VERIFIER_VERSION,
      defaultRetentionMs: Number(env.EVIDENCE_DEFAULT_RETENTION_MS),
    });
  },
};
