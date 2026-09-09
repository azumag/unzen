import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import {
  WASM_CANARY_CONTRACT,
  validateWasmCanaryPayload,
} from '../tools/wasm_canary_contract.mjs';
import {
  APPROVAL_ENV,
  APPROVAL_VALUE,
  CANARY_NAME,
  buildAuthorizedCanaryCommand,
} from '../tools/wasm_canary_deploy_gate.mjs';
import {
  checkRemoteCanary,
  validateCanaryUrl,
} from '../tools/check_wasm_canary_remote.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(projectRoot, 'worker-runtime', 'wasm-canary-worker.mjs');
const COMPATIBILITY_DATE = '2026-08-06';

function createRuntime(): Miniflare {
  return new Miniflare({
    modules: true,
    modulesRoot: projectRoot,
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    scriptPath,
    compatibilityDate: COMPATIBILITY_DATE,
  });
}

describe('isolated Cloudflare Wasm canary contract', () => {
  it('returns the pinned deterministic response through Miniflare', async () => {
    const mf = createRuntime();
    try {
      await mf.ready;
      const response = await mf.dispatchFetch('https://wasm-canary.internal/');
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({ status: 'pass', ...WASM_CANARY_CONTRACT });
      expect(validateWasmCanaryPayload(payload)).toEqual({ status: 'valid' });
    } finally {
      await mf.dispose();
    }
  });

  it('rejects non-GET requests without invoking an alternate operation', async () => {
    const mf = createRuntime();
    try {
      await mf.ready;
      const response = await mf.dispatchFetch('https://wasm-canary.internal/', { method: 'POST' });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET');
    } finally {
      await mf.dispose();
    }
  });

  it('fails the smoke contract on identity or result drift', () => {
    for (const mutated of [
      { status: 'pass', ...WASM_CANARY_CONTRACT, wasmSha256: '0'.repeat(64) },
      { status: 'pass', ...WASM_CANARY_CONTRACT, wasmBytes: 110 },
      { status: 'pass', ...WASM_CANARY_CONTRACT, moduleType: 'ArrayBuffer' },
      { status: 'pass', ...WASM_CANARY_CONTRACT, result: 1 },
      { status: 'fail', ...WASM_CANARY_CONTRACT },
    ]) {
      expect(validateWasmCanaryPayload(mutated).status).toBe('invalid');
    }
  });

  it('restricts the remote checker to isolated HTTPS workers.dev URLs', () => {
    expect(validateCanaryUrl('https://unzen-wasm-feasibility-canary.example.workers.dev/').hostname)
      .toBe('unzen-wasm-feasibility-canary.example.workers.dev');
    expect(() => validateCanaryUrl('http://example.workers.dev/')).toThrow(/https/);
    expect(() => validateCanaryUrl('https://example.com/')).toThrow(/workers\.dev/);
    expect(() => validateCanaryUrl('https://user:pass@example.workers.dev/')).toThrow(/credentials/);
  });

  it('validates repeated remote samples without requiring network in CI', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return Response.json({ status: 'pass', ...WASM_CANARY_CONTRACT });
    };
    const report = await checkRemoteCanary(
      'https://unzen-wasm-feasibility-canary.example.workers.dev/',
      { fetchImpl, samples: 3 },
    );
    expect(report.status).toBe('pass');
    expect(report.samples).toHaveLength(3);
    expect(calls).toBe(3);
  });
});

describe('Cloudflare Wasm canary deployment gate', () => {
  const baseEnv = {
    [APPROVAL_ENV]: APPROVAL_VALUE,
    CLOUDFLARE_API_TOKEN: 'test-token-not-used',
    CLOUDFLARE_ACCOUNT_ID: 'test-account-not-used',
  };

  it('fails closed unless execution, explicit approval, token, and account are all present', () => {
    expect(() => buildAuthorizedCanaryCommand({ action: 'deploy', execute: false, env: baseEnv }))
      .toThrow(/--execute/);
    expect(() => buildAuthorizedCanaryCommand({ action: 'deploy', execute: true, env: {} }))
      .toThrow(new RegExp(APPROVAL_ENV));
    expect(() => buildAuthorizedCanaryCommand({
      action: 'deploy',
      execute: true,
      env: { [APPROVAL_ENV]: APPROVAL_VALUE },
    })).toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(() => buildAuthorizedCanaryCommand({
      action: 'deploy',
      execute: true,
      env: { [APPROVAL_ENV]: APPROVAL_VALUE, CLOUDFLARE_API_TOKEN: 'test-token-not-used' },
    })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it('only builds commands for the pinned isolated canary after every gate passes', () => {
    for (const action of ['deploy', 'delete'] as const) {
      const command = buildAuthorizedCanaryCommand({ action, execute: true, env: baseEnv });
      expect(command.command).toBe('npx');
      expect(command.args.join(' ')).toContain('wrangler@4.129.1');
      expect(command.args.join(' ')).toContain('wrangler-wasm-canary.jsonc');
      if (action === 'delete') expect(command.args).toContain(CANARY_NAME);
      expect(JSON.stringify(command)).not.toContain(baseEnv.CLOUDFLARE_API_TOKEN);
      expect(JSON.stringify(command)).not.toContain(baseEnv.CLOUDFLARE_ACCOUNT_ID);
    }
  });

  it('does not accept arbitrary actions', () => {
    expect(() => buildAuthorizedCanaryCommand({
      action: 'publish',
      execute: true,
      env: baseEnv,
    })).toThrow(/Unsupported canary action/);
  });
});
