import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runner = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-v3.js', import.meta.url),
  'utf8',
);
const atomicPublisher = readFileSync(
  new URL('../tools/prepare_budgeted_multi_split_atomic.py', import.meta.url),
  'utf8',
);

function mibLimit(source: string, name: string) {
  const pattern = new RegExp(`${name}\\s*=\\s*(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024`);
  const match = source.match(pattern);
  expect(match, `${name} must remain a simple MiB constant`).not.toBeNull();
  return Number(match?.[1]) * 1024 * 1024;
}

describe('browser split manifest bounded read', () => {
  it('routes split-manifest.json through the bounded artifact reader', () => {
    expect(runner).toContain('readResponseBytesBounded,');
    expect(runner).toContain('const MAX_SPLIT_MANIFEST_BYTES = 4 * 1024 * 1024;');

    const match = runner.match(
      /async function loadManifest\(signal\) \{([\s\S]*?)\n\}\n\nasync function loadTokenizer/,
    );
    expect(match).not.toBeNull();
    const body = match?.[1] ?? '';

    expect(body).toContain("const manifestUrl = modelUrl('split-manifest.json');");
    expect(body).toContain('const bytes = await readResponseBytesBounded(response, {');
    expect(body).toContain('maxBytes: MAX_SPLIT_MANIFEST_BYTES,');
    expect(body).toContain('url: manifestUrl,');
    expect(body).toContain('signal,');
    expect(body).toContain("JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))");
    expect(body).not.toContain('new TextDecoder().decode(bytes)');
    expect(body).not.toContain('response.arrayBuffer()');
  });

  it('keeps the browser manifest ceiling aligned with atomic publication', () => {
    const browserLimit = mibLimit(runner, 'MAX_SPLIT_MANIFEST_BYTES');
    const previousManifestLimit = mibLimit(atomicPublisher, 'MAX_PREVIOUS_MANIFEST_BYTES');
    const stagedManifestLimit = mibLimit(atomicPublisher, 'MAX_STAGED_MANIFEST_BYTES');

    expect(browserLimit).toBe(previousManifestLimit);
    expect(browserLimit).toBe(stagedManifestLimit);
  });
});
