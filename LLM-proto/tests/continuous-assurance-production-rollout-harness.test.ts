import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRolloutDeploymentPlan,
  executeRolloutDeploymentPlan,
  redactedRolloutDeploymentManifest,
} from '../scripts/deploy-continuous-assurance-production-rollout.mjs';
import {
  handleProductionOperationsRolloutInvokerRequest,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout-invoker.js';

const SECRET = 'rollout-controller-secret-fixture';
const BASE_RESULT = {
  status: 'deployment-complete',
  manifest: {
    deployCommitSha: 'a'.repeat(40),
    deploymentManifestSha256: 'b'.repeat(64),
    coreDeploymentRoles: ['controller', 'runtime', 'engine', 'provider', 'evidence', 'pager', 'verifier'],
    expectedConfigFingerprints: {
      controller: '1'.repeat(64), runtime: '2'.repeat(64), engine: '3'.repeat(64), provider: '4'.repeat(64),
      evidence: '5'.repeat(64), pager: '6'.repeat(64), verifier: '7'.repeat(64),
    },
  },
};

describe('continuous assurance production rollout harness', () => {
  it('derives rollout services from the exact base #145 identity without changing it', async () => {
    const plan = await buildRolloutDeploymentPlan({ baseResult: BASE_RESULT, mode: 'plan', env: {} });
    expect(plan.baseDeploymentIdentity).toEqual({
      deployCommitSha: BASE_RESULT.manifest.deployCommitSha,
      deploymentManifestSha256: BASE_RESULT.manifest.deploymentManifestSha256,
      expectedConfigFingerprints: BASE_RESULT.manifest.expectedConfigFingerprints,
    });
    expect(plan.services.map((service) => service.role)).toEqual(['rollout-verifier', 'rollout-controller']);
    const controller = plan.services.find((service) => service.role === 'rollout-controller')!;
    expect(controller.vars.EXPECTED_DEPLOY_COMMIT_SHA).toBe(BASE_RESULT.manifest.deployCommitSha);
    expect(controller.vars.EXPECTED_DEPLOYMENT_MANIFEST_SHA256).toBe(BASE_RESULT.manifest.deploymentManifestSha256);
  });

  it('redacts rollout secret and operational routing values from the deployment manifest', async () => {
    const env = {
      CLOUDFLARE_API_TOKEN: 'cf-token-value', CLOUDFLARE_ACCOUNT_ID: 'cf-account-value',
      ROLLOUT_CONTROLLER_SECRET: SECRET, ROLLOUT_ONCALL_ROUTE: 'private-oncall-route', ROLLOUT_ESCALATION_TARGET: 'private-escalation',
    };
    const plan = await buildRolloutDeploymentPlan({ baseResult: BASE_RESULT, mode: 'apply', env });
    const text = JSON.stringify(redactedRolloutDeploymentManifest(plan));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('cf-token-value');
    expect(text).not.toContain('cf-account-value');
    expect(text).not.toContain('private-oncall-route');
    expect(text).not.toContain('private-escalation');
    expect(text).toContain('ROLLOUT_CONTROLLER_SECRET');
  });

  it('uses stdin for rollout secret provisioning and never places its value in command arguments', async () => {
    const env = {
      CLOUDFLARE_API_TOKEN: 'cf-token', CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      ROLLOUT_CONTROLLER_SECRET: SECRET, ROLLOUT_ONCALL_ROUTE: 'route', ROLLOUT_ESCALATION_TARGET: 'target',
    };
    const plan = await buildRolloutDeploymentPlan({ baseResult: BASE_RESULT, mode: 'apply', env });
    const calls: Array<{ command: string[]; stdin?: string }> = [];
    const result = await executeRolloutDeploymentPlan(plan, {
      env,
      runner: async (command: string[], options: { stdin?: string }) => {
        calls.push({ command, stdin: options.stdin });
        return { ok: true, code: 0, stdout: '', stderr: '' };
      },
    });
    expect(result.events.some((event) => event.kind === 'secret-bulk')).toBe(true);
    expect(calls.some((call) => call.stdin?.includes(SECRET))).toBe(true);
    expect(calls.every((call) => !call.command.join(' ').includes(SECRET))).toBe(true);
  });

  it('keeps rollout Workers internal-only and the invoker loopback-only with a remote Service Binding', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const [controller, verifier, invoker] = await Promise.all([
      readFile(join(root, 'worker-runtime', 'wrangler.production-rollout.jsonc'), 'utf8'),
      readFile(join(root, 'worker-runtime', 'wrangler.production-rollout-verifier.jsonc'), 'utf8'),
      readFile(join(root, 'worker-runtime', 'wrangler.production-rollout-invoker.jsonc'), 'utf8'),
    ]);
    for (const config of [controller, verifier]) {
      expect(config).toContain('"workers_dev": false');
      expect(config).toContain('"preview_urls": false');
      expect(config).not.toContain('"routes"');
      expect(config).not.toContain('"crons"');
    }
    expect(invoker).toContain('"workers_dev": false');
    expect(invoker).toContain('"preview_urls": false');
    expect(invoker).toContain('"remote": true');
    expect(invoker).toContain('"ip": "127.0.0.1"');
    expect(invoker).toContain('"port": 8792');
    expect(invoker).not.toContain('"routes"');
    expect(invoker).not.toContain('"crons"');
  });

  it('forwards only loopback invocation through the rollout controller secret header', async () => {
    let calls = 0;
    let forwarded: Request | undefined;
    const body = JSON.stringify({ phase: 'observe-only' });
    const response = await handleProductionOperationsRolloutInvokerRequest(new Request('http://127.0.0.1:8792/invoke', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }), {
      controllerSecret: SECRET,
      rolloutController: {
        async fetch(input, init) {
          calls += 1;
          forwarded = input instanceof Request ? input : new Request(input, init);
          expect(forwarded.headers.get('x-unzen-rollout-secret')).toBe(SECRET);
          expect(await forwarded.clone().text()).toBe(body);
          return Response.json({ status: 'phase-completed' });
        },
      },
    });
    expect(calls).toBe(1);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(SECRET);

    calls = 0;
    const blocked = await handleProductionOperationsRolloutInvokerRequest(new Request('https://example.com/invoke', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }), {
      controllerSecret: SECRET,
      rolloutController: { async fetch() { calls += 1; return new Response(); } },
    });
    expect(blocked.status).toBe(403);
    expect(calls).toBe(0);
  });

  it('extends the manual production workflow without making rollout secret job-wide', async () => {
    const repoRoot = decodeURIComponent(new URL('../..', import.meta.url).pathname);
    const workflow = await readFile(join(repoRoot, '.github', 'workflows', 'continuous-assurance-production-ops.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s*push:/m);
    expect(workflow).not.toMatch(/^\s*schedule:/m);
    expect(workflow).toContain('deploy-continuous-assurance-production-rollout.mjs --apply');
    expect(workflow).toContain('${{ secrets.ROLLOUT_CONTROLLER_SECRET }}');
    const beforeSteps = workflow.split(/^\s{4}steps:/m)[0] ?? '';
    expect(beforeSteps).not.toContain('${{ secrets.');
    const dryRun = workflow.slice(workflow.indexOf('- name: Run authenticated dry-run'), workflow.indexOf('- name: Deploy production services'));
    expect(dryRun).not.toContain('${{ secrets.ROLLOUT_CONTROLLER_SECRET }}');
  });
});
