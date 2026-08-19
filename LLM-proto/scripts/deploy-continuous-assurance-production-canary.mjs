#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const R2_BUCKET = 'unzen-continuous-assurance-evidence';

export const DEPLOYMENT_SERVICES = Object.freeze([
  {
    role: 'verifier',
    service: 'unzen-llm-continuous-assurance-independent-verifier',
    config: 'worker-runtime/wrangler.independent-verifier.jsonc',
    secrets: [],
    vars: {},
  },
  {
    role: 'provider',
    service: 'unzen-llm-continuous-assurance-provider-adapter',
    config: 'worker-runtime/wrangler.provider-adapter.jsonc',
    secrets: ['PROVIDER_API_TOKEN'],
    vars: { PROVIDER_API_BASE_URL: 'PROVIDER_API_BASE_URL' },
  },
  {
    role: 'pager',
    service: 'unzen-llm-continuous-assurance-pager-adapter',
    config: 'worker-runtime/wrangler.pager-adapter.jsonc',
    secrets: ['PAGER_API_TOKEN'],
    vars: { PAGER_API_URL: 'PAGER_API_URL' },
  },
  {
    role: 'evidence',
    service: 'unzen-llm-continuous-assurance-evidence-adapter',
    config: 'worker-runtime/wrangler.evidence-adapter.jsonc',
    secrets: [],
    vars: { EVIDENCE_PRODUCER_COMMIT_SHA: 'DEPLOY_COMMIT_SHA' },
  },
  {
    role: 'engine',
    service: 'unzen-llm-continuous-assurance-engine',
    config: 'worker-runtime/wrangler.engine.jsonc',
    secrets: ['ENGINE_BOOTSTRAP_SECRET', 'CANARY_DISPATCH_SECRET'],
    vars: {},
  },
  {
    role: 'runtime',
    service: 'unzen-llm-continuous-assurance',
    config: 'worker-runtime/wrangler.jsonc',
    secrets: ['CANARY_DISPATCH_SECRET'],
    vars: {},
  },
  {
    role: 'controller',
    service: 'unzen-llm-continuous-assurance-production-canary',
    config: 'worker-runtime/wrangler.production-canary.jsonc',
    secrets: ['CANARY_DISPATCH_SECRET', 'CANARY_CONTROLLER_SECRET'],
    vars: { DEPLOY_COMMIT_SHA: 'DEPLOY_COMMIT_SHA' },
  },
]);

const REQUIRED_ACCOUNT_ENV = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
const REQUIRED_APPLY_ENV = [
  ...REQUIRED_ACCOUNT_ENV,
  'DEPLOY_COMMIT_SHA',
  'PROVIDER_API_BASE_URL',
  'PAGER_API_URL',
  'PROVIDER_API_TOKEN',
  'PAGER_API_TOKEN',
  'ENGINE_BOOTSTRAP_SECRET',
  'CANARY_DISPATCH_SECRET',
  'CANARY_CONTROLLER_SECRET',
];
const SECRET_NAMES = new Set(DEPLOYMENT_SERVICES.flatMap((service) => service.secrets));

export async function buildDeploymentPlan({ env = process.env, mode = 'plan' } = {}) {
  if (!['plan', 'dry-run', 'apply'].includes(mode)) throw new Error(`unsupported-deployment-mode:${mode}`);
  const required = mode === 'apply' ? REQUIRED_APPLY_ENV : mode === 'dry-run' ? REQUIRED_ACCOUNT_ENV : [];
  const missing = required.filter((name) => !nonEmpty(env[name]));
  if (missing.length > 0) throw new Error(`deployment-input-missing:${missing.join(',')}`);

  const services = [];
  for (const service of DEPLOYMENT_SERVICES) {
    const configPath = join(PROJECT_ROOT, service.config);
    const raw = await readFile(configPath);
    const resolvedVars = Object.fromEntries(
      Object.entries(service.vars).map(([target, source]) => [target, env[source] ?? `<${source}>`]),
    );
    const configFingerprintSha256 = sha256Hex(Buffer.concat([
      raw,
      Buffer.from(`\n--unzen-deploy-vars-v1--\n${stableJson(resolvedVars)}`, 'utf8'),
    ]));
    const vars = {
      CONFIG_FINGERPRINT_SHA256: configFingerprintSha256,
      ...resolvedVars,
    };
    services.push({
      role: service.role,
      service: service.service,
      config: service.config,
      configPath,
      configFingerprintSha256,
      secrets: [...service.secrets],
      vars,
    });
  }

  const deployCommitSha = env.DEPLOY_COMMIT_SHA ?? '<DEPLOY_COMMIT_SHA>';
  const deploymentIdentity = {
    schemaVersion: '1.0.0',
    bucket: R2_BUCKET,
    deployCommitSha,
    services: services.map((service) => ({
      role: service.role,
      service: service.service,
      configFingerprintSha256: service.configFingerprintSha256,
    })),
  };
  const deploymentManifestSha256 = sha256Hex(Buffer.from(stableJson(deploymentIdentity), 'utf8'));
  const controller = services.find((service) => service.role === 'controller');
  if (!controller) throw new Error('deployment-controller-missing');
  controller.vars.DEPLOY_MANIFEST_SHA256 = deploymentManifestSha256;

  return {
    schemaVersion: '1.0.0',
    mode,
    bucket: R2_BUCKET,
    accountConfigured: REQUIRED_ACCOUNT_ENV.every((name) => nonEmpty(env[name])),
    requiredEnvironment: mode === 'apply' ? REQUIRED_APPLY_ENV : mode === 'dry-run' ? REQUIRED_ACCOUNT_ENV : [],
    deployCommitSha,
    deploymentManifestSha256,
    services,
    secretNames: [...SECRET_NAMES].sort(),
  };
}

export function redactedDeploymentManifest(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    mode: plan.mode,
    bucket: plan.bucket,
    accountConfigured: plan.accountConfigured,
    requiredEnvironment: plan.requiredEnvironment,
    deployCommitSha: plan.deployCommitSha,
    deploymentManifestSha256: plan.deploymentManifestSha256,
    secretNames: plan.secretNames,
    services: plan.services.map((service) => ({
      role: service.role,
      service: service.service,
      config: service.config,
      configFingerprintSha256: service.configFingerprintSha256,
      requiredSecrets: service.secrets,
      vars: Object.fromEntries(Object.entries(service.vars).map(([name, value]) => [
        name,
        name === 'CONFIG_FINGERPRINT_SHA256' || name === 'DEPLOY_COMMIT_SHA' || name === 'DEPLOY_MANIFEST_SHA256'
          ? value
          : `<${name}>`,
      ])),
    })),
  };
}

export async function executeDeploymentPlan(plan, options = {}) {
  const env = options.env ?? process.env;
  const runner = options.runner ?? runCommand;
  const events = [];
  const versionIdentities = [];
  const run = async (args, extra = {}) => {
    events.push({ command: ['npx', 'wrangler@latest', ...redactArgs(args)], kind: extra.kind ?? 'command' });
    return runner(['npx', 'wrangler@latest', ...args], {
      cwd: PROJECT_ROOT,
      env,
      stdin: extra.stdin,
    });
  };

  if (plan.mode === 'plan') return { events, manifest: redactedDeploymentManifest(plan), versionIdentities };

  await run(['whoami'], { kind: 'auth-check' });
  for (const service of plan.services) {
    await run(['check', '--config', service.configPath], { kind: 'config-check' });
  }

  if (plan.mode === 'dry-run') {
    for (const service of plan.services) {
      await run(deployArgs(service, true), { kind: 'deploy-dry-run' });
    }
    return { events, manifest: redactedDeploymentManifest(plan), versionIdentities };
  }

  const info = await run(['r2', 'bucket', 'info', plan.bucket], { kind: 'r2-info' }).catch((error) => ({ ok: false, error }));
  if (!info?.ok) await run(['r2', 'bucket', 'create', plan.bucket], { kind: 'r2-create' });

  for (const service of plan.services) {
    for (const secretName of service.secrets) {
      const value = env[secretName];
      if (!nonEmpty(value)) throw new Error(`deployment-secret-missing:${secretName}`);
      await run(['secret', 'put', secretName, '--config', service.configPath], {
        kind: 'secret-put',
        stdin: `${value}\n`,
      });
    }
    const deployed = await run(deployArgs(service, false), { kind: 'deploy' });
    const versionId = extractVersionId(`${deployed.stdout ?? ''}\n${deployed.stderr ?? ''}`);
    if (!versionId) throw new Error(`deployment-version-id-missing:${service.role}`);
    versionIdentities.push({
      role: service.role,
      service: service.service,
      versionId,
      configFingerprintSha256: service.configFingerprintSha256,
    });
  }

  return { events, manifest: redactedDeploymentManifest(plan), versionIdentities };
}

function deployArgs(service, dryRun) {
  const args = ['deploy', '--config', service.configPath, '--keep-vars'];
  if (dryRun) args.push('--dry-run');
  for (const [name, value] of Object.entries(service.vars)) {
    args.push('--var', `${name}:${value}`);
  }
  return args;
}

export async function runCommand(command, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      const result = {
        ok: code === 0,
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolvePromise(result);
      else rejectPromise(Object.assign(new Error(`wrangler-command-failed:${command.slice(0, 4).join(' ')}`), { result }));
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function extractVersionId(output) {
  const matches = [
    /Current\s+Version\s+ID\s*:\s*([A-Za-z0-9-]{8,128})/i,
    /Version\s+ID\s*:\s*([A-Za-z0-9-]{8,128})/i,
  ];
  for (const pattern of matches) {
    const match = output.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function redactArgs(args) {
  return args.map((value) => SECRET_NAMES.has(value) ? value : value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseMode(argv) {
  const flags = new Set(argv);
  if (flags.has('--apply')) return 'apply';
  if (flags.has('--dry-run')) return 'dry-run';
  return 'plan';
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const plan = await buildDeploymentPlan({ mode });
  const result = await executeDeploymentPlan(plan);
  process.stdout.write(`${JSON.stringify({
    status: mode === 'plan' ? 'planned' : mode === 'dry-run' ? 'dry-run-complete' : 'deployment-complete',
    evidenceLevel: mode === 'apply' ? 'deployment-executed-unverified' : 'deployment-plan-only',
    manifest: result.manifest,
    versionIdentities: result.versionIdentities,
    events: result.events,
  }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
