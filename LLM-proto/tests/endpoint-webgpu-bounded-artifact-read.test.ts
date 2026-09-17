import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runnerPaths = [
  '../browser-harness/endpoint-tile-webgpu/runner.js',
  '../browser-harness/endpoint-five-way-tile-webgpu/runner.js',
  '../browser-harness/endpoint-embedding-tiled-webgpu/runner.js',
  '../browser-harness/endpoint-poststage-tiled-webgpu/runner.js',
  '../browser-harness/endpoint-embedding-eight-physical-webgpu/runner.js',
] as const;

function loadRunner(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('endpoint WebGPU artifact reads', () => {
  for (const relativePath of runnerPaths) {
    it(`${relativePath} uses the shared bounded reader`, () => {
      const runner = loadRunner(relativePath);
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
    });
  }
});
