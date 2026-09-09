import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(projectRoot, 'worker-runtime', 'wasm-esm-compat-worker.mjs');
const wasmPath = join(projectRoot, 'worker-runtime', 'wasm-fixtures', 'add-i32.wasm');
const COMPATIBILITY_DATE = '2026-08-06';
const WASM_BYTES = 41;
const WASM_SHA256 = 'f61fd62f57c41269c3c23f360eeaf1090b1db9c38651106674d48bc65dba88ba';

function createCompiledWasmRuntime(): Miniflare {
  return new Miniflare({
    modules: true,
    modulesRoot: projectRoot,
    modulesRules: [
      { type: 'CompiledWasm', include: ['**/*.wasm'] },
    ],
    scriptPath,
    compatibilityDate: COMPATIBILITY_DATE,
  });
}

describe('Cloudflare Wasm ESM module compatibility spike', () => {
  it('pins the deterministic Wasm fixture identity', async () => {
    const bytes = await readFile(wasmPath);
    expect(bytes.byteLength).toBe(WASM_BYTES);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(WASM_SHA256);
  });

  it('imports .wasm as WebAssembly.Module and instantiates it at module scope', async () => {
    const mf = createCompiledWasmRuntime();
    try {
      await mf.ready;

      const first = await mf.dispatchFetch('https://wasm-esm.internal/');
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toEqual({
        status: 'pass',
        moduleType: 'WebAssembly.Module',
        result: 42,
      });

      const second = await mf.dispatchFetch('https://wasm-esm.internal/');
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toEqual({
        status: 'pass',
        moduleType: 'WebAssembly.Module',
        result: 42,
      });
    } finally {
      await mf.dispose();
    }
  });

  it('fails closed when the .wasm module is wired as non-Wasm data', () => {
    const childScript = `
      import { Miniflare } from 'miniflare';
      const mf = new Miniflare({
        modules: true,
        modulesRoot: ${JSON.stringify(projectRoot)},
        modulesRules: [{ type: 'Data', include: ['**/*.wasm'] }],
        scriptPath: ${JSON.stringify(scriptPath)},
        compatibilityDate: ${JSON.stringify(COMPATIBILITY_DATE)},
      });
      await mf.ready;
    `;

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', childScript],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'wasm-esm-compat: imported .wasm is not a WebAssembly.Module',
    );
  });
});
