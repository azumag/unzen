import engineWorker, { ContinuousAssuranceEngineState } from './continuous-assurance-engine-worker.mjs';

export { ContinuousAssuranceEngineState };

const SERVICE = 'unzen-llm-continuous-assurance-engine';
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

async function authorizedCanary(request, env) {
  return secretEquals(request.headers.get('x-unzen-canary-secret'), env.CANARY_DISPATCH_SECRET);
}

async function meta(binding, name) {
  const response = await binding.fetch(new Request(`https://${name}.internal/__meta`, { method: 'GET' }));
  if (!response.ok) throw new Error(`engine-canary-binding-meta-http-${name}-${response.status}`);
  return response.json();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/__meta') {
      return Response.json(deploymentMetadata(env));
    }
    if (request.method === 'GET' && url.pathname === '/__canary/state') {
      if (!(await authorizedCanary(request, env))) return Response.json({ error: 'forbidden' }, { status: 403 });
      const scope = url.searchParams.get('scope') || DEFAULT_SCOPE;
      const state = await env.ENGINE_STATE.getByName(scope).readState(scope);
      const evidence = state.snapshot?.steadyStateOperationsEvidence;
      return Response.json({
        scope,
        currentRunId: state.currentRunId,
        snapshotUpdatedAtMs: state.snapshot?.updatedAtMs ?? null,
        nextDueAtMs: evidence?.payload?.schedule?.nextDueAtMs ?? null,
      });
    }
    if (request.method === 'GET' && url.pathname === '/__canary/bindings') {
      if (!(await authorizedCanary(request, env))) return Response.json({ error: 'forbidden' }, { status: 403 });
      try {
        const [provider, evidence, pager] = await Promise.all([
          meta(env.PROVIDER_ADAPTER, 'provider'),
          meta(env.EVIDENCE_ADAPTER, 'evidence'),
          meta(env.PAGER_ADAPTER, 'pager'),
        ]);
        return Response.json({ provider, evidence, pager });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
      }
    }
    return engineWorker.fetch(request, env, ctx);
  },
};
