import engineWorker, { ContinuousAssuranceEngineState } from './continuous-assurance-engine-worker.mjs';

export { ContinuousAssuranceEngineState };

const SERVICE = 'unzen-llm-continuous-assurance-engine';

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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/__meta') {
      return Response.json(deploymentMetadata(env));
    }
    return engineWorker.fetch(request, env, ctx);
  },
};
