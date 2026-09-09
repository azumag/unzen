import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WRANGLER_VERSION = '4.129.1';
export const CANARY_NAME = 'unzen-wasm-feasibility-canary';
export const APPROVAL_ENV = 'UNZEN_CLOUDFLARE_CANARY_DEPLOY_APPROVED';
export const APPROVAL_VALUE = 'I_APPROVE_ISOLATED_WASM_CANARY';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(projectRoot, 'wrangler-wasm-canary.jsonc');

export function buildAuthorizedCanaryCommand({ action, execute, env = process.env }) {
  if (action !== 'deploy' && action !== 'delete') {
    throw new Error(`Unsupported canary action: ${action}`);
  }
  if (execute !== true) {
    throw new Error('Canary execution is disabled unless --execute is supplied.');
  }
  if (env[APPROVAL_ENV] !== APPROVAL_VALUE) {
    throw new Error(`Canary execution requires ${APPROVAL_ENV}=${APPROVAL_VALUE}.`);
  }
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new Error('Canary execution requires CLOUDFLARE_API_TOKEN.');
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('Canary execution requires CLOUDFLARE_ACCOUNT_ID.');
  }

  const wranglerArgs = action === 'deploy'
    ? ['deploy', '--config', configPath]
    : ['delete', '--config', configPath, '--name', CANARY_NAME];

  return {
    command: 'npx',
    args: ['--yes', `--package=wrangler@${WRANGLER_VERSION}`, 'wrangler', ...wranglerArgs],
    cwd: projectRoot,
  };
}

function printPlan(action) {
  process.stdout.write(`${JSON.stringify({
    status: 'blocked-until-explicit-execution',
    action,
    canaryName: CANARY_NAME,
    wranglerVersion: WRANGLER_VERSION,
    productionRoutesConfigured: false,
    requiredExecuteFlag: '--execute',
    requiredApprovalEnvironment: APPROVAL_ENV,
    requiresCloudflareApiToken: true,
    requiresCloudflareAccountId: true,
  }, null, 2)}\n`);
}

function main() {
  const action = process.argv[2];
  const execute = process.argv.includes('--execute');
  if (action !== 'deploy' && action !== 'delete') {
    throw new Error('Usage: node tools/wasm_canary_deploy_gate.mjs <deploy|delete> [--execute]');
  }

  if (!execute) {
    printPlan(action);
    return;
  }

  const command = buildAuthorizedCanaryCommand({ action, execute, env: process.env });
  const result = spawnSync(command.command, command.args, {
    cwd: command.cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      CI: '1',
      WRANGLER_SEND_METRICS: 'false',
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Wrangler ${action} failed with exit ${result.status}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
