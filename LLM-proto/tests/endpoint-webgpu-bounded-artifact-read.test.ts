import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const harnesses = [
  '../browser-harness/endpoint-tile-webgpu',
  '../browser-harness/endpoint-five-way-tile-webgpu',
  '../browser-harness/endpoint-embedding-tiled-webgpu',
  '../browser-harness/endpoint-poststage-tiled-webgpu',
  '../browser-harness/endpoint-embedding-eight-physical-webgpu',
] as const;

function loadSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('endpoint WebGPU artifact reads', () => {
  for (const harnessPath of harnesses) {
    it(`${harnessPath} uses and serves the shared bounded reader`, () => {
      const runner = loadSource(`${harnessPath}/runner.js`);
      expect(runner).toContain(
        "import { BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES } from '../webgpu-2b-split/artifact-budget.js';",
      );
      expect(runner).toContain(
        "import { readResponseBytesBounded } from '../webgpu-2b-split/artifact-cache.js';",
      );

      const match = runner.match(
        /async function loadVerified\(path, expectedBytes, expectedSha256\) \{([\s\S]*?)\n\}\n\nfunction /,
      );
      expect(match, 'loadVerified() must remain a standalone helper').not.toBeNull();
      const body = match?.[1] ?? '';

      expect(body).toContain('const data = await readResponseBytesBounded(response, {');
      expect(body).toContain('maxBytes: BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,');
      expect(body).toContain('expectedBytes,');
      expect(body).toContain('url: path,');
      expect(body).not.toContain('response.arrayBuffer()');

      const server = loadSource(`${harnessPath}/serve.mjs`);
      expect(server).toContain("import { safePath } from '../webgpu-2b-split/server-safe-path.mjs';");
      expect(server).toContain("const SHARED_SPLIT_ROOT = resolve(ROOT, '../webgpu-2b-split');");
      expect(server).toContain("url.pathname.startsWith('/webgpu-2b-split/')");
      expect(server).toContain(
        "safePath(SHARED_SPLIT_ROOT, url.pathname.slice('/webgpu-2b-split/'.length))",
      );
      expect(server).not.toContain('function safePath(');
    });
  }
});
