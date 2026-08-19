import { handleContinuousAssuranceProviderAdapterRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.ts';

const SERVICE = 'unzen-llm-continuous-assurance-provider-adapter';

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
    return handleContinuousAssuranceProviderAdapterRequest(request, {
      apiBaseUrl: env.PROVIDER_API_BASE_URL,
      apiToken: env.PROVIDER_API_TOKEN,
    });
  },
};
