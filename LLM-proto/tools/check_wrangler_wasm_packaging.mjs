import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const WRANGLER_VERSION = '4.129.1';
const COMPATIBILITY_DATE = '2026-08-06';
const EXPECTED_WASM_BYTES = 41;
const EXPECTED_WASM_SHA256 = 'f61fd62f57c41269c3c23f360eeaf1090b1db9c38651106674d48bc65dba88ba';
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(projectRoot, 'wrangler-wasm-packaging.jsonc');

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

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Wrangler command failed with exit ${result.status}:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function parseByteValue(value, unit) {
  const scale = unit === 'MiB' ? 1024 * 1024 : unit === 'KiB' ? 1024 : 1;
  return Math.round(Number(value) * scale);
}

function parseUploadBytes(output) {
  const match = output.match(/Total Upload:\s*([0-9.]+)\s*(B|KiB|MiB)(?:\s*\/\s*gzip:\s*([0-9.]+)\s*(B|KiB|MiB))?/i);
  if (!match) {
    throw new Error(`Could not parse Wrangler Total Upload output:\n${output}`);
  }
  return {
    totalUploadBytes: parseByteValue(match[1], match[2]),
    gzipBytes: match[3] ? parseByteValue(match[3], match[4]) : null,
  };
}

const versionOutput = runWrangler(['--version']).trim();
if (!versionOutput.includes(WRANGLER_VERSION)) {
  throw new Error(`Expected Wrangler ${WRANGLER_VERSION}, got: ${versionOutput}`);
}

const outdir = await mkdtemp(join(tmpdir(), 'unzen-wrangler-wasm-'));
try {
  const deployOutput = runWrangler([
    'deploy',
    '--config',
    configPath,
    '--dry-run',
    '--outdir',
    outdir,
  ]);
  const upload = parseUploadBytes(deployOutput);
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

    if (bytes.subarray(0, 4).equals(WASM_MAGIC)) {
      wasmModules.push({ ...item, filename: basename(file) });
    }
    if (/\.(?:m?js|cjs)$/i.test(file)) {
      jsModules.push({ ...item, text: bytes.toString('utf8') });
    }
  }

  const matchingWasm = wasmModules.filter(
    (module) => module.bytes === EXPECTED_WASM_BYTES && module.sha256 === EXPECTED_WASM_SHA256,
  );
  if (matchingWasm.length !== 1) {
    throw new Error(
      `Expected exactly one preserved ${EXPECTED_WASM_BYTES}-byte Wasm module with SHA-256 ${EXPECTED_WASM_SHA256}; found ${matchingWasm.length}. Files: ${JSON.stringify(evidence)}`,
    );
  }
  if (jsModules.length === 0) {
    throw new Error(`Wrangler emitted no JavaScript entry module. Files: ${JSON.stringify(evidence)}`);
  }

  const sourceWasm = await readFile(join(projectRoot, 'worker-runtime', 'wasm-fixtures', 'add-i32.wasm'));
  const wasmBase64 = sourceWasm.toString('base64');
  const generatedJs = jsModules.map((module) => module.text).join('\n');
  if (generatedJs.includes(wasmBase64)) {
    throw new Error('Generated JavaScript contains the entire Wasm fixture as base64; expected a separate Wasm module.');
  }

  const wasmFilename = matchingWasm[0].filename;
  const jsReferencesWasmModule = generatedJs.includes(wasmFilename) || generatedJs.includes('.wasm');
  if (!jsReferencesWasmModule) {
    throw new Error(
      `Generated JavaScript does not reference the emitted Wasm module ${wasmFilename}.`,
    );
  }

  const report = {
    status: 'pass',
    wranglerVersion: WRANGLER_VERSION,
    wranglerVersionOutput: versionOutput,
    compatibilityDate: COMPATIBILITY_DATE,
    dryRunOnly: true,
    credentialsRequired: false,
    expectedWranglerImportContract: {
      extension: '.wasm',
      importedType: 'WebAssembly.Module',
      packagingShape: 'separate module',
    },
    observed: {
      separateWasmModule: true,
      wasmIdentityPreserved: true,
      generatedJsContainsFullWasmBase64: false,
      generatedJsReferencesWasmModule: true,
      emittedModuleCount: evidence.length,
      emittedJavaScriptModuleCount: jsModules.length,
      emittedWasmModuleCount: wasmModules.length,
      totalUploadBytes: upload.totalUploadBytes,
      gzipBytes: upload.gzipBytes,
      modules: evidence,
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(outdir, { recursive: true, force: true });
}
