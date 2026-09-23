import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(projectRoot, 'worker-runtime', 'segment-geometry-wasm-worker.mjs');
const COMPATIBILITY_DATE = '2026-08-06';
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function createRuntime(): Miniflare {
  return new Miniflare({
    modules: true,
    modulesRoot: projectRoot,
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    scriptPath,
    compatibilityDate: COMPATIBILITY_DATE,
  });
}

async function postBytes(mf: Miniflare, bytes: Uint8Array): Promise<Response> {
  return mf.dispatchFetch('https://segment-geometry.internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(bytes),
  });
}

function validPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    totalLayers: 1,
    segments: [{ index: 0, layerStart: 0, layerEnd: 0 }],
    ...extra,
  };
}

describe('segment geometry Wasm request boundary', () => {
  it('rejects malformed UTF-8 before replacement decoding can normalize valid JSON', async () => {
    const mf = createRuntime();
    try {
      await mf.ready;
      const prefix = new TextEncoder().encode(
        '{"totalLayers":1,"segments":[{"index":0,"layerStart":0,"layerEnd":0}],"note":"',
      );
      const suffix = new TextEncoder().encode('"}');
      const bytes = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
      bytes.set(prefix, 0);
      bytes[prefix.byteLength] = 0xff;
      bytes.set(suffix, prefix.byteLength + 1);

      expect(() => JSON.parse(new TextDecoder().decode(bytes))).not.toThrow();

      const response = await postBytes(mf, bytes);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        status: 'invalid',
        reason: 'invalid-json',
        wasmCalled: false,
      });
    } finally {
      await mf.dispose();
    }
  });

  it('rejects a syntactically valid JSON body above the explicit byte ceiling', async () => {
    const mf = createRuntime();
    try {
      await mf.ready;
      const bytes = new TextEncoder().encode(
        JSON.stringify(validPayload({ padding: 'a'.repeat(MAX_REQUEST_BYTES) })),
      );
      expect(bytes.byteLength).toBeGreaterThan(MAX_REQUEST_BYTES);

      const response = await postBytes(mf, bytes);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        status: 'invalid',
        reason: 'invalid-json',
        wasmCalled: false,
      });
    } finally {
      await mf.dispose();
    }
  });

  it('preserves valid UTF-8 BOM JSON behavior', async () => {
    const mf = createRuntime();
    try {
      await mf.ready;
      const json = new TextEncoder().encode(JSON.stringify(validPayload()));
      const bytes = new Uint8Array(3 + json.byteLength);
      bytes.set([0xef, 0xbb, 0xbf]);
      bytes.set(json, 3);

      const response = await postBytes(mf, bytes);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'valid',
        reasonCode: 0,
        reason: null,
        wasmCalled: true,
        moduleType: 'WebAssembly.Module',
      });
    } finally {
      await mf.dispose();
    }
  });
});
