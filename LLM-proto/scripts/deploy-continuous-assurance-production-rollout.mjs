#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './deploy-continuous-assurance-production-canary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

export const ROLLOUT_DEPLOYMENT_SERVICES = Object.freeze([
  {
    role: 'rollout-verifier',
    service: 'unzen-llm-continuous-assurance-production-rollout-verifier',
    config: 'worker-runtime/wrangler.production-rollout-verifier.jsonc',
    secrets: [],
    vars: {},
  },
  {
    role: 'rollout-controller',
    service: 'unzen-llm-continuous-assurance-production-rollout',
    config: 'worker-runtime/wrangler.production-rollout.jsonc',
    secrets: ['ROLLOUT_CONTROLLER_SECRET'],
    vars: {
      EXPECTED_DEPLOY_COMMIT_SHA: 'BASE_DEPLOY_COMMIT_SHA',
      EXPECTED_DEPLOYMENT_MANIFEST_SHA256: 'BASE_DEPLOYMENT_MANIFEST_SHA256',
      EXPECTED_CONFIG_FINGERPRINTS_JSON: 'BASE_CONFIG_FINGERPRINTS_JSON',
      ROLLOUT_ONCALL_ROUTE: 'ROLLOUT_ONCALL_ROUTE',
      ROLLOUT_ESCALATION_TARGET: 'ROLLOUT_ESCALATION_TARGET',
    },
  },
]);

const REQUIRED_ACCOUNT_ENV = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
const REQUIRED_APPLY_ENV = [
  ...REQUIRED_ACCOUNT_ENV,
  'ROLLOUT_CONTROLLER_SECRET',
  'ROLLOUT_ONCALL_ROUTE',
  'ROLLOUT_ESCALATION_TARGET',
];
const VISIBLE_VARS = new Set([
  'CONFIG_FINGERPRINT_SHA256',
  'EXPECTED_DEPLOY_COMMIT_SHA',
  'EXPECTED_DEPLOYMENT_MANIFEST_SHA256',
  'EXPECTED_CONFIG_FINGERPRINTS_JSON',
]);

export async function buildRolloutDeploymentPlan({ baseResult, env = process.env, mode = 'plan' }) {
  if (!['plan', 'dry-run', 'apply'].includes(mode)) throw new Error(`unsupported-rollout-deployment-mode:${mode}`);
  const required = mode === 'apply' ? REQUIRED_APPLY_ENV : mode === 'dry-run' ? REQUIRED_ACCOUNT_ENV : [];
  const missing = required.filter((name) => !nonEmpty(env[name]));
  if (missing.length > 0) throw new Error(`rollout-deployment-input-missing:${missing.join(',')}`);
  const base = validateBaseResult(baseResult, mode);
  const derivedEnv = {
    ...env,
    BASE_DEPLOY_COMMIT_SHA: base.deployCommitSha,
    BASE_DEPLOYMENT_MANIFEST_SHA256: base.deploymentManifestSha256,
    BASE_CONFIG_FINGERPRINTS_JSON: stableJson(base.expectedConfigFingerprints),
  };
  const services = [];
  for (const service of ROLLOUT_DEPLOYMENT_SERVICES) services.push(await resolveService(service, derivedEnv));
  return {
    schemaVersion: '1.0.0',
    mode,
    baseDeploymentIdentity: {
      deployCommitSha: base.deployCommitSha,
      deploymentManifestSha256: base.deploymentManifestSha256,
      expectedConfigFingerprints: base.expectedConfigFingerprints,
    },
    accountConfigured: REQUIRED_ACCOUNT_ENV.every((name) => nonEmpty(env[name])),
    requiredEnvironment: required,
    services,
    secretNames: [...new Set(services.flatMap((service) => service.secrets))].sort(),
  };
}

function validateBaseResult(baseResult, mode) {
  const manifest = baseResult?.manifest;
  if (!manifest || typeof manifest !== 'object' || !nonEmpty(manifest.deployCommitSha) ||
    !/^[a-f0-9]{64}$/.test(manifest.deploymentManifestSha256 || '') ||
    !manifest.expectedConfigFingerprints || typeof manifest.expectedConfigFingerprints !== 'object') {
    throw new Error('rollout-base-deployment-result-invalid');
  }
  const requiredRoles = ['controller', 'runtime', 'engine', 'provider', 'evidence', 'pager', 'verifier'];
  if (!Array.isArray(manifest.coreDeploymentRoles) || requiredRoles.some((role) => !manifest.coreDeploymentRoles.includes(role))) {
    throw new Error('rollout-base-core-deployment-roles-invalid');
  }
  if (mode === 'apply' && (!/^[a-f0-9]{40}$/.test(manifest.deployCommitSha) || manifest.deployCommitSha.includes('<'))) {
    throw new Error('rollout-base-deploy-commit-invalid');
  }
  return manifest;
}

async function resolveService(service, env) {
  const configPath = join(PROJECT_ROOT, service.config);
  const raw = await readFile(configPath);
  const resolvedVars = Object.fromEntries(
    Object.entries(service.vars).map(([target, source]) => [target, env[source] ?? `<${source}>`]),
  );
  const configFingerprintSha256 = createHash('sha256').update(Buffer.concat([
    raw,
    Buffer.from(`\n--unzen-rollout-deploy-vars-v1--\n${stableJson(resolvedVars)}`, 'utf8'),
  ])).digest('hex');
  return {
    role: service.role,
    service: service.service,
    config: service.config,
    configPath,
    configFingerprintSha256,
    secrets: [...service.secrets],
    vars: { CONFIG_FINGERPRINT_SHA256: configFingerprintSha256, ...resolvedVars },
  };
}

export function redactedRolloutDeploymentManifest(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    mode: plan.mode,
    accountConfigured: plan.accountConfigured,
    requiredEnvironment: plan.requiredEnvironment,
    baseDeploymentIdentity: plan.baseDeploymentIdentity,
    secretNames: plan.secretNames,
    services: plan.services.map((service) => ({
      role: service.role,
      service: service.service,
      config: service.config,
      configFingerprintSha256: service.configFingerprintSha256,
      requiredSecrets: service.secrets,
      vars: Object.fromEntries(Object.entries(service.vars).map(([name, value]) => [
        name,
        VISIBLE_VARS.has(name) ? value : `<${name}>`,
      ])),
    })),
  };
}

export async function executeRolloutDeploymentPlan(plan, options = {}) {
  const env = options.env ?? process.env;
  const runner = options.runner ?? runCommand;
  const events = [];
  const run = async (args, extra = {}) => {
    events.push({ command: ['npx', 'wrangler@latest', ...args], kind: extra.kind ?? 'command' });
    return runner(['npx', 'wrangler@latest', ...args], {
      cwd: PROJECT_ROOT,
      env: { ...env, ...(extra.env ?? {}) },
      stdin: extra.stdin,
    });
  };
  if (plan.mode === 'plan') return { events, manifest: redactedRolloutDeploymentManifest(plan) };
  await run(['whoami'], { kind: 'auth-check' });
  for (const service of plan.services) await run(deployArgs(service, true), { kind: 'deploy-preflight' });
  if (plan.mode === 'dry-run') return { events, manifest: redactedRolloutDeploymentManifest(plan) };
  for (const service of plan.services) {
    if (service.secrets.length > 0) {
      const secretPayload = {};
      for (const name of service.secrets) {
        if (!nonEmpty(env[name])) throw new Error(`rollout-deployment-secret-missing:${name}`);
        secretPayload[name] = env[name];
      }
      await run(['secret', 'bulk', '--config', service.configPath], {
        kind: 'secret-bulk',
        stdin: `${JSON.stringify(secretPayload)}\n`,
      });
    }
    await run(deployArgs(service, false), { kind: 'deploy' });
  }
  return { events, manifest: redactedRolloutDeploymentManifest(plan) };
}

function deployArgs(service, dryRun) {
  const args = ['deploy', '--config', service.configPath];
  if (dryRun) args.push('--dry-run');
  for (const [name, value] of Object.entries(service.vars)) args.push('--var', `${name}:${value}`);
  return args;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function parseMode(argv) {
  const flags = new Set(argv);
  if (flags.has('--apply')) return 'apply';
  if (flags.has('--dry-run')) return 'dry-run';
  return 'plan';
}
function baseResultPath(argv) {
  const index = argv.indexOf('--base-result');
  if (index < 0 || !argv[index + 1]) throw new Error('rollout-base-result-path-required');
  return resolve(process.cwd(), argv[index + 1]);
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = parseMode(argv);
  const baseResult = JSON.parse(await readFile(baseResultPath(argv), 'utf8'));
  const plan = await buildRolloutDeploymentPlan({ baseResult, mode });
  const result = await executeRolloutDeploymentPlan(plan);
  process.stdout.write(`${JSON.stringify({
    status: mode === 'plan' ? 'planned' : mode === 'dry-run' ? 'dry-run-complete' : 'deployment-complete',
    evidenceLevel: mode === 'apply' ? 'deployment-executed-unverified' : 'deployment-plan-only',
    manifest: result.manifest,
    events: result.events,
  }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
