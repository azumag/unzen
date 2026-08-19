import { handleContinuousAssuranceProviderAdapterRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.ts';

export default {
  async fetch(request, env) {
    return handleContinuousAssuranceProviderAdapterRequest(request, {
      apiBaseUrl: env.PROVIDER_API_BASE_URL,
      apiToken: env.PROVIDER_API_TOKEN,
    });
  },
};
