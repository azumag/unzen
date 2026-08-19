import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_SERVICES,
  buildDeploymentPlan,
  executeDeploymentPlan,
  redactedDeploymentManifest,
} from '../scripts/deploy-continuous-assurance-production-canary.mjs';

function value(name: string) {
  return `${name.toLowerCase()}-fixture-value`;
}

function applyEnv() {
  return {
    CLOUDFLARE_API_TOKEN: value('CLOUDFLARE_API_TOKEN'),
    CLOUDFLARE_ACCOUNT_ID: value('CLOUDFLARE_ACCOUNT_ID'),
    DEPLOY_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
    PROVIDER_API_BASE_URL: 'https://provider.example.test',
    PAGER_API_URL: 'https://pager.example.test/events',
    PROVIDER_API_TOKEN: value('PROVIDER_API_TOKEN'),
    PAGER_API_TOKEN: value('PAGER_API_TOKEN'),
    ENGINE_BOOTSTRAP_SECRET: value('ENGINE_BOOTSTRAP_SECRET'),
    CANARY_DISPATCH_SECRET: value('CANARY_DISPATCH_SECRET'),
    CANARY_CONTROLLER_SECRET: value('CANARY_CONTROLLER_SECRET'),
  };
}

describe('continuous assurance production deployment plan', () => {
  it('builds a deterministic dependency order with config fingerprints and no secret values', async () => {
    const env = applyEnv();
    const plan = await buildDeploymentPlan({ mode: 'apply', env });
    expect(plan.services.map((service) => service.role)).toEqual([
      'verifier', 'provider', 'pager', 'evidence', 'engine', 'runtime', 'controller',
    ]);
    expect(plan.services).toHaveLength(DEPLOYMENT_SERVICES.length);
    expect(plan.services.every((service) => /^[a-f0-9]{64}$/.test(service.configFingerprintSha256))).toBe(true);
    const manifest = JSON.stringify(redactedDeploymentManifest(plan));
    for (const name of ['PROVIDER_API_TOKEN', 'PAGER_API_TOKEN', 'ENGINE_BOOTSTRAP_SECRET', 'CANARY_DISPATCH_SECRET', 'CANARY_CONTROLLER_SECRET']) {
      expect(manifest).not.toContain(env[name as keyof typeof env]);
    }
  });

  it('fails closed before apply when account or deployment inputs are missing', async () => {
    await expect(buildDeploymentPlan({ mode: 'apply', env: {} })).rejects.toThrow('deployment-input-missing:');
    await expect(buildDeploymentPlan({ mode: 'dry-run', env: {} })).rejects.toThrow('deployment-input-missing:');
    await expect(buildDeploymentPlan({ mode: 'plan', env: {} })).resolves.toMatchObject({ mode: 'plan', accountConfigured: false });
  });

  it('passes secret values only through stdin and never includes them in command events', async () => {
    const env = applyEnv();
    const plan = await buildDeploymentPlan({ mode: 'apply', env });
    const calls: { command: string[]; stdin?: string }[] = [];
    const runner = async (command: string[], options: { stdin?: string }) => {
      calls.push({ command, stdin: options.stdin });
      return { ok: true, code: 0, stdout: '', stderr: '' };
    };
    const result = await executeDeploymentPlan(plan, { env, runner });
    const eventText = JSON.stringify(result.events);
    const manifestText = JSON.stringify(result.manifest);
    for (const name of ['PROVIDER_API_TOKEN', 'PAGER_API_TOKEN', 'ENGINE_BOOTSTRAP_SECRET', 'CANARY_DISPATCH_SECRET', 'CANARY_CONTROLLER_SECRET']) {
      const secret = env[name as keyof typeof env];
      expect(eventText).not.toContain(secret);
      expect(manifestText).not.toContain(secret);
    }
    const secretCalls = calls.filter((call) => call.command.includes('secret') && call.command.includes('put'));
    expect(secretCalls).toHaveLength(7);
    expect(secretCalls.every((call) => typeof call.stdin === 'string' && call.stdin.endsWith('\n'))).toBe(true);
    const deployRoles = result.events.filter((event: any) => event.kind === 'deploy').length;
    expect(deployRoles).toBe(7);
  });
});
