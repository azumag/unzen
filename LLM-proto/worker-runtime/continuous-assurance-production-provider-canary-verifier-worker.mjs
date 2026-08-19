import { handleProductionProviderCanaryVerifierRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary-verifier.ts';

export default {
  async fetch(request, env) {
    return handleProductionProviderCanaryVerifierRequest(request, {
      verifierName: env.VERIFIER_NAME,
      verifierVersion: env.VERIFIER_VERSION,
    });
  },
};
