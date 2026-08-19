import { handleContinuousAssurancePagerAdapterRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.ts';

const SERVICE = 'unzen-llm-continuous-assurance-pager-adapter';

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
    return handleContinuousAssurancePagerAdapterRequest(request, {
      apiUrl: env.PAGER_API_URL,
      apiToken: env.PAGER_API_TOKEN,
      maxAttempts: Number(env.PAGER_MAX_ATTEMPTS || '2'),
    });
  },
};
