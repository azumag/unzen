import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANARY_NAME, WRANGLER_VERSION } from './wasm_canary_deploy_gate.mjs';
import { WASM_CANARY_CONTRACT } from './wasm_canary_contract.mjs';

const COMPATIBILITY_DATE = '2026-08-06';
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(projectRoot, 'wrangler-wasm-canary.jsonc');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function runWrangler(args) {
  const result = spawnSync(
    'npx',
    ['--yes', `--package=wrangler@${WRANGLER_VERSION}`, 'wrangler', ...args],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CI: '1',
        WRANGLER_SEND_METRICS: 'false',
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wrangler dry-run failed with exit ${result.status}:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

async function walkFiles(current) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const configText = await readFile(configPath, 'utf8');
const config = JSON.parse(configText);
if (config.name !== CANARY_NAME) throw new Error(`Unexpected canary name: ${config.name}`);
if (config.main !== 'worker-runtime/wasm-canary-worker.mjs') throw new Error(`Unexpected canary main: ${config.main}`);
if (config.compatibility_date !== COMPATIBILITY_DATE) throw new Error(`Unexpected compatibility date: ${config.compatibility_date}`);
if (config.workers_dev !== true) throw new Error('Canary must be isolated on workers.dev.');
for (const forbiddenKey of ['account_id', 'routes', 'route', 'vars', 'kv_namespaces', 'r2_buckets', 'd1_databases', 'durable_objects', 'services']) {
  if (Object.hasOwn(config, forbiddenKey)) {
    throw new Error(`Canary config must not contain production/environment binding key: ${forbiddenKey}`);
  }
}

const versionOutput = runWrangler(['--version']).trim();
if (!versionOutput.includes(WRANGLER_VERSION)) {
  throw new Error(`Expected Wrangler ${WRANGLER_VERSION}, got: ${versionOutput}`);
}

const outdir = await mkdtemp(join(tmpdir(), 'unzen-wasm-canary-'));
try {
  const output = runWrangler(['deploy', '--config', configPath, '--dry-run', '--outdir', outdir]);
  const files = await walkFiles(outdir);
  const evidence = [];
  const wasmModules = [];
  const jsModules = [];

  for (const file of files) {
    const bytes = await readFile(file);
    const info = await stat(file);
    const item = {
      path: relative(outdir, file).replaceAll('\\', '/'),
      bytes: info.size,
      sha256: sha256(bytes),
    };
    evidence.push(item);
    if (bytes.subarray(0, 4).equals(WASM_MAGIC)) wasmModules.push({ ...item, filename: basename(file) });
    if (/\.(?:m?js|cjs)$/i.test(file)) jsModules.push({ ...item, text: bytes.toString('utf8') });
  }

  const matchingWasm = wasmModules.filter(
    (module) => module.bytes === WASM_CANARY_CONTRACT.wasmBytes && module.sha256 === WASM_CANARY_CONTRACT.wasmSha256,
  );
  if (matchingWasm.length !== 1) {
    throw new Error(`Expected exactly one preserved canary Wasm module; found ${matchingWasm.length}. Files: ${JSON.stringify(evidence)}`);
  }
  if (jsModules.length === 0) throw new Error(`Wrangler emitted no JavaScript canary entry module. Files: ${JSON.stringify(evidence)}`);

  const sourceWasm = await readFile(join(projectRoot, 'worker-runtime', 'wasm-fixtures', 'segment-geometry.wasm'));
  const generatedJs = jsModules.map((module) => module.text).join('\n');
  if (generatedJs.includes(sourceWasm.toString('base64'))) {
    throw new Error('Generated canary JavaScript contains the full Wasm fixture as base64.');
  }
  for (const requiredText of [
    WASM_CANARY_CONTRACT.canary,
    WASM_CANARY_CONTRACT.contractVersion,
    WASM_CANARY_CONTRACT.wasmSha256,
  ]) {
    if (!generatedJs.includes(requiredText)) {
      throw new Error(`Generated canary JavaScript is missing contract marker: ${requiredText}`);
    }
  }

  const wasmFilename = matchingWasm[0].filename;
  if (!generatedJs.includes(wasmFilename) && !generatedJs.includes('.wasm')) {
    throw new Error(`Generated JavaScript does not reference emitted Wasm module ${wasmFilename}.`);
  }
  if (/account[_-]?id|api[_-]?token|cloudflare_api_token/i.test(generatedJs)) {
    throw new Error('Generated canary JavaScript unexpectedly contains credential-shaped identifiers.');
  }

  process.stdout.write(`${JSON.stringify({
    status: 'pass',
    canaryName: CANARY_NAME,
    wranglerVersion: WRANGLER_VERSION,
    compatibilityDate: COMPATIBILITY_DATE,
    dryRunOnly: true,
    productionRoutesConfigured: false,
    environmentBindingsConfigured: false,
    wasmIdentityPreserved: true,
    wasmBytes: matchingWasm[0].bytes,
    wasmSha256: matchingWasm[0].sha256,
    emittedJavaScriptModuleCount: jsModules.length,
    emittedWasmModuleCount: wasmModules.length,
    emittedFiles: evidence,
    wranglerOutputContainsDryRun: /dry[- ]?run/i.test(output),
  }, null, 2)}\n`);
} finally {
  await rm(outdir, { recursive: true, force: true });
}
