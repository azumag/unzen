import { handleContinuousAssuranceIndependentVerifierRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-independent-verifier.ts';

const SERVICE = 'unzen-llm-continuous-assurance-independent-verifier';

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
    return handleContinuousAssuranceIndependentVerifierRequest(request, {
      verifierName: env.VERIFIER_NAME,
      verifierVersion: env.VERIFIER_VERSION,
    });
  },
};
