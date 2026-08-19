import {
  handleProductionOperationsRolloutInvokerRequest,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout-invoker.ts';

export default {
  fetch(request, env) {
    return handleProductionOperationsRolloutInvokerRequest(request, {
      rolloutController: env.ROLLOUT_CONTROLLER,
      controllerSecret: env.ROLLOUT_CONTROLLER_SECRET,
    });
  },
};
