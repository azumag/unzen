import { handleContinuousAssuranceEvidenceAdapterRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.ts';

const SERVICE = 'unzen-llm-continuous-assurance-evidence-adapter';

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/__meta') {
      return Response.json(deploymentMetadata(env));
    }
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
