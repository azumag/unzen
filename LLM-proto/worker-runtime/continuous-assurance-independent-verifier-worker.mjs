import { handleContinuousAssuranceIndependentVerifierRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-independent-verifier.ts';

export default {
  async fetch(request, env) {
    return handleContinuousAssuranceIndependentVerifierRequest(request, {
      verifierName: env.VERIFIER_NAME,
      verifierVersion: env.VERIFIER_VERSION,
    });
  },
};
