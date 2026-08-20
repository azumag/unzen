import {
  handleProductionOperationsRolloutVerifierRequest,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout-verifier.ts';

export default {
  fetch(request, env) {
    return handleProductionOperationsRolloutVerifierRequest(request, {
      verifierName: env.VERIFIER_NAME,
      verifierVersion: env.VERIFIER_VERSION,
    });
  },
};
