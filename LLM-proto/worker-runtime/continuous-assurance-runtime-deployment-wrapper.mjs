import runtimeWorker, { ContinuousAssuranceRuntimeState } from './continuous-assurance-worker.mjs';

export { ContinuousAssuranceRuntimeState };

const SERVICE = 'unzen-llm-continuous-assurance';
const DEFAULT_SCOPE = 'publisher-tax-exception-archive-dr';

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

async function secretEquals(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

function validDispatch(input) {
  return input && typeof input.cron === 'string' && input.cron.length > 0 && input.cron.length <= 128 &&
    Number.isFinite(input.scheduledTimeMs) && Number.isFinite(input.deliveryAtMs) &&
    input.deliveryAtMs >= input.scheduledTimeMs;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/__meta') {
      return Response.json(deploymentMetadata(env));
    }
    if (request.method === 'POST' && url.pathname === '/__canary/dispatch') {
      const authorized = await secretEquals(
        request.headers.get('x-unzen-canary-secret'),
        env.CANARY_DISPATCH_SECRET,
      );
      if (!authorized) return Response.json({ error: 'forbidden' }, { status: 403 });
      let input;
      try {
        input = await request.json();
      } catch {
        return Response.json({ error: 'invalid-json' }, { status: 400 });
      }
      if (!validDispatch(input)) return Response.json({ error: 'invalid-canary-dispatch' }, { status: 400 });
      const scope = env.CONTINUOUS_ASSURANCE_SCOPE || DEFAULT_SCOPE;
      try {
        const result = await env.CONTINUOUS_ASSURANCE_STATE.getByName(scope).runScheduled({
          cron: input.cron,
          scheduledTimeMs: input.scheduledTimeMs,
          deliveryAtMs: input.deliveryAtMs,
        });
        return Response.json(result);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
      }
    }
    return runtimeWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return runtimeWorker.scheduled(controller, env, ctx);
  },
};
