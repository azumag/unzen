import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  CORE_DEPLOYMENT_SERVICES,
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
    PROVIDER_CANARY_CONTROLLER_SECRET: value('PROVIDER_CANARY_CONTROLLER_SECRET'),
    PROVIDER_CANARY_ONCALL_ROUTE: 'oncall-production',
    PROVIDER_CANARY_ESCALATION_TARGET: 'ops-lead',
  };
}

const ALL_SECRET_ENV = [
  'PROVIDER_API_TOKEN',
  'PAGER_API_TOKEN',
  'ENGINE_BOOTSTRAP_SECRET',
  'CANARY_DISPATCH_SECRET',
  'CANARY_CONTROLLER_SECRET',
  'PROVIDER_CANARY_CONTROLLER_SECRET',
] as const;

describe('continuous assurance production deployment plan', () => {
  it('preserves the core deployment manifest identity while adding provider-canary deployment services', async () => {
    const env = applyEnv();
    const plan = await buildDeploymentPlan({ mode: 'apply', env });
    expect(plan.coreDeploymentRoles).toEqual([
      'verifier', 'provider', 'pager', 'evidence', 'engine', 'runtime', 'controller',
    ]);
    expect(plan.coreDeploymentRoles).toHaveLength(CORE_DEPLOYMENT_SERVICES.length);
    expect(plan.services.map((service) => service.role)).toEqual([
      'verifier',
      'provider',
      'pager',
      'evidence',
      'engine',
      'runtime',
      'controller',
      'provider-canary-verifier',
      'provider-canary-controller',
    ]);
    expect(plan.services).toHaveLength(DEPLOYMENT_SERVICES.length);
    expect(plan.services.every((service) => /^[a-f0-9]{64}$/.test(service.configFingerprintSha256))).toBe(true);
    expect(plan.deploymentManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.deployCommitSha).toBe(env.DEPLOY_COMMIT_SHA);
    expect(plan.services.find((service) => service.role === 'controller')?.vars.DEPLOY_MANIFEST_SHA256)
      .toBe(plan.deploymentManifestSha256);
    const providerCanary = plan.services.find((service) => service.role === 'provider-canary-controller');
    expect(providerCanary?.vars.EXPECTED_DEPLOY_COMMIT_SHA).toBe(env.DEPLOY_COMMIT_SHA);
    expect(providerCanary?.vars.EXPECTED_DEPLOYMENT_MANIFEST_SHA256).toBe(plan.deploymentManifestSha256);
    expect(JSON.parse(providerCanary?.vars.EXPECTED_CONFIG_FINGERPRINTS_JSON ?? '{}'))
      .toEqual(plan.expectedConfigFingerprints);

    const changedCore = await buildDeploymentPlan({
      mode: 'apply',
      env: { ...env, PROVIDER_API_BASE_URL: 'https://provider-2.example.test' },
    });
    expect(changedCore.services.find((service) => service.role === 'provider')?.configFingerprintSha256)
      .not.toBe(plan.services.find((service) => service.role === 'provider')?.configFingerprintSha256);
    expect(changedCore.deploymentManifestSha256).not.toBe(plan.deploymentManifestSha256);

    const changedPostDeployOnly = await buildDeploymentPlan({
      mode: 'apply',
      env: { ...env, PROVIDER_CANARY_ONCALL_ROUTE: 'oncall-production-v2' },
    });
    expect(changedPostDeployOnly.deploymentManifestSha256).toBe(plan.deploymentManifestSha256);
    expect(changedPostDeployOnly.services.find((service) => service.role === 'provider-canary-controller')?.configFingerprintSha256)
      .not.toBe(providerCanary?.configFingerprintSha256);

    const manifest = JSON.stringify(redactedDeploymentManifest(plan));
    for (const name of ALL_SECRET_ENV) {
      expect(manifest).not.toContain(env[name]);
    }
  });

  it('fails closed before apply when account or deployment inputs are missing', async () => {
    await expect(buildDeploymentPlan({ mode: 'apply', env: {} })).rejects.toThrow('deployment-input-missing:');
    await expect(buildDeploymentPlan({ mode: 'dry-run', env: {} })).rejects.toThrow('deployment-input-missing:');
    await expect(buildDeploymentPlan({ mode: 'plan', env: {} })).resolves.toMatchObject({ mode: 'plan', accountConfigured: false });
  });

  it('preflights every service, bulk-provisions secrets through stdin, and records exact Worker version IDs from Wrangler structured output', async () => {
    const env = applyEnv();
    const plan = await buildDeploymentPlan({ mode: 'apply', env });
    const calls: { command: string[]; stdin?: string }[] = [];
    let deployIndex = 0;
    const runner = async (command: string[], options: { stdin?: string; env?: Record<string, string> }) => {
      calls.push({ command, stdin: options.stdin });
      const isDeploy = command.includes('deploy') && !command.includes('--dry-run');
      if (isDeploy) {
        const service = plan.services[deployIndex];
        deployIndex += 1;
        const outputPath = options.env?.WRANGLER_OUTPUT_FILE_PATH;
        expect(outputPath).toBeTruthy();
        await writeFile(outputPath!, `${JSON.stringify({
          type: 'deploy',
          version: 1,
          worker_name: service.service,
          version_id: `version-deployed-${deployIndex}-12345678`,
          timestamp: new Date().toISOString(),
        })}\n`, 'utf8');
      }
      return { ok: true, code: 0, stdout: '', stderr: '' };
    };
    const result = await executeDeploymentPlan(plan, { env, runner });
    const eventText = JSON.stringify(result.events);
    const manifestText = JSON.stringify(result.manifest);
    for (const name of ALL_SECRET_ENV) {
      const secret = env[name];
      expect(eventText).not.toContain(secret);
      expect(manifestText).not.toContain(secret);
    }

    const preflight = result.events.filter((event: any) => event.kind === 'deploy-preflight');
    expect(preflight).toHaveLength(9);
    expect(preflight.every((event: any) => event.command.includes('--dry-run'))).toBe(true);
    expect(result.events.every((event: any) => !event.command.includes('--keep-vars'))).toBe(true);

    const bulkCalls = calls.filter((call) => call.command.includes('secret') && call.command.includes('bulk'));
    expect(bulkCalls).toHaveLength(6);
    const expectedBulkSecretSets = [
      ['PROVIDER_API_TOKEN'],
      ['PAGER_API_TOKEN'],
      ['ENGINE_BOOTSTRAP_SECRET', 'CANARY_DISPATCH_SECRET'],
      ['CANARY_DISPATCH_SECRET'],
      ['CANARY_CONTROLLER_SECRET', 'CANARY_DISPATCH_SECRET'],
      ['PROVIDER_CANARY_CONTROLLER_SECRET'],
    ].map((items) => items.sort());
    const actualBulkSecretSets = bulkCalls.map((call) => Object.keys(JSON.parse(call.stdin ?? '{}')).sort());
    expect(actualBulkSecretSets).toEqual(expectedBulkSecretSets);
    expect(bulkCalls.every((call) => typeof call.stdin === 'string' && call.stdin.endsWith('\n'))).toBe(true);

    const deployRoles = result.events.filter((event: any) => event.kind === 'deploy').length;
    expect(deployRoles).toBe(9);
    expect(result.versionIdentities).toHaveLength(9);
    expect(result.versionIdentities.map((identity: any) => identity.role)).toEqual([
      'verifier',
      'provider',
      'pager',
      'evidence',
      'engine',
      'runtime',
      'controller',
      'provider-canary-verifier',
      'provider-canary-controller',
    ]);
    expect(result.versionIdentities.every((identity: any) => /^version-deployed-\d+-12345678$/.test(identity.versionId))).toBe(true);
  });

  it('fails closed if Wrangler structured deploy output does not expose a version ID', async () => {
    const env = applyEnv();
    const plan = await buildDeploymentPlan({ mode: 'apply', env });
    const runner = async (command: string[], options: { env?: Record<string, string> }) => {
      if (command.includes('deploy') && !command.includes('--dry-run')) {
        const outputPath = options.env?.WRANGLER_OUTPUT_FILE_PATH;
        await writeFile(outputPath!, `${JSON.stringify({
          type: 'deploy',
          version: 1,
          worker_name: plan.services[0].service,
          timestamp: new Date().toISOString(),
        })}\n`, 'utf8');
      }
      return { ok: true, code: 0, stdout: '', stderr: '' };
    };
    await expect(executeDeploymentPlan(plan, { env, runner }))
      .rejects.toThrow(`deployment-version-id-missing:${plan.services[0].service}`);
  });
});
