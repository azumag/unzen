import { handleContinuousAssurancePagerAdapterRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.ts';

export default {
  async fetch(request, env) {
    return handleContinuousAssurancePagerAdapterRequest(request, {
      apiUrl: env.PAGER_API_URL,
      apiToken: env.PAGER_API_TOKEN,
      maxAttempts: Number(env.PAGER_MAX_ATTEMPTS || '2'),
    });
  },
};
