import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_DIAGNOSTIC_MANIFEST_MAX_BYTES,
  readEndpointDiagnosticManifestResponse,
} from '../browser-harness/webgpu-2b-split/diagnostic-manifest.js';

const RUNNERS = [
  'endpoint-tile-webgpu',
  'endpoint-five-way-tile-webgpu',
  'endpoint-embedding-tiled-webgpu',
  'endpoint-poststage-tiled-webgpu',
] as const;

describe('endpoint diagnostic manifest bounded read', () => {
  it('keeps the browser control-document ceiling aligned with the split manifest policy', () => {
    expect(ENDPOINT_DIAGNOSTIC_MANIFEST_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  it('parses a bounded manifest response', async () => {
    const value = await readEndpointDiagnosticManifestResponse(
      new Response('{"status":"pass"}', {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(value).toEqual({ status: 'pass' });
  });

  it('preserves the existing UTF-8 BOM behavior', async () => {
    const json = new TextEncoder().encode('{"status":"pass"}');
    const bytes = new Uint8Array(3 + json.byteLength);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(json, 3);

    const value = await readEndpointDiagnosticManifestResponse(
      new Response(bytes, {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(value).toEqual({ status: 'pass' });
  });

  it('rejects malformed UTF-8 before replacement decoding can yield valid JSON', async () => {
    const prefix = new TextEncoder().encode('{"status":"');
    const suffix = new TextEncoder().encode('"}');
    const bytes = new Uint8Array(prefix.byteLength + 2 + suffix.byteLength);
    bytes.set(prefix, 0);
    bytes.set([0xc3, 0x28], prefix.byteLength);
    bytes.set(suffix, prefix.byteLength + 2);

    await expect(
      readEndpointDiagnosticManifestResponse(
        new Response(bytes, {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects an oversized declared manifest before JSON parsing', async () => {
    const response = new Response('{"status":"pass"}', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(ENDPOINT_DIAGNOSTIC_MANIFEST_MAX_BYTES + 1),
      },
    });
    await expect(readEndpointDiagnosticManifestResponse(response)).rejects.toThrow(
      /artifact exceeds byte limit before body read/,
    );
  });

  for (const harness of RUNNERS) {
    it(`routes ${harness} manifest through the bounded reader`, () => {
      const runner = readFileSync(
        new URL(`../browser-harness/${harness}/runner.js`, import.meta.url),
        'utf8',
      );
      expect(runner).toContain("readEndpointDiagnosticManifestResponse } from '../webgpu-2b-split/diagnostic-manifest.js'");
      expect(runner).toContain('readEndpointDiagnosticManifestResponse(manifestResponse)');
      expect(runner).not.toContain('manifestResponse.json()');
    });
  }
});
