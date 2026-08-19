import {
  handleProductionProviderCanaryInvokerRequest,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary-invoker.ts';

export default {
  fetch(request, env) {
    return handleProductionProviderCanaryInvokerRequest(request, {
      providerCanary: env.PROVIDER_CANARY_CONTROLLER,
      controllerSecret: env.PROVIDER_CANARY_CONTROLLER_SECRET,
    });
  },
};
