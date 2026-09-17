import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runner = readFileSync(
  new URL('../browser-harness/webgpu-2b-split/runner-v3.js', import.meta.url),
  'utf8',
);

describe('browser split manifest bounded read', () => {
  it('routes split-manifest.json through the bounded artifact reader', () => {
    expect(runner).toContain('readResponseBytesBounded,');
    expect(runner).toContain('const MAX_SPLIT_MANIFEST_BYTES = 4 * 1024 * 1024;');

    const match = runner.match(
      /async function loadManifest\(signal\) \{([\s\S]*?)\n\}\n\nfunction normalizeTokenIds/,
    );
    expect(match).not.toBeNull();
    const body = match?.[1] ?? '';

    expect(body).toContain("const manifestUrl = modelUrl('split-manifest.json');");
    expect(body).toContain('const bytes = await readResponseBytesBounded(response, {');
    expect(body).toContain('maxBytes: MAX_SPLIT_MANIFEST_BYTES,');
    expect(body).toContain('url: manifestUrl,');
    expect(body).toContain('signal,');
    expect(body).not.toContain('response.arrayBuffer()');
  });
});
