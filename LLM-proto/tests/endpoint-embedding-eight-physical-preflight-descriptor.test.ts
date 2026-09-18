import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function serverSource() {
  return readFileSync(
    new URL('../browser-harness/endpoint-embedding-eight-physical-webgpu/serve.mjs', import.meta.url),
    'utf8',
  );
}

function runnerSource() {
  return readFileSync(
    new URL('../browser-harness/endpoint-embedding-eight-physical-webgpu/runner.js', import.meta.url),
    'utf8',
  );
}

describe('8-physical endpoint preflight descriptor binding', () => {
  it('reads the preflight JSON only from the accepted FileHandle and keeps the host allocation bounded', () => {
    const server = serverSource();
    expect(server).toContain(
      "import { openExistingNonSymlinkFile } from '../webgpu-2b-split/server-safe-path.mjs';",
    );
    expect(server).toContain(
      'const { handle, info: before } = await openNonSymlinkFileForField(path, field);',
    );
    expect(server).toContain('const MAX_PREFLIGHT_REPORT_BYTES = 16 * 1024 * 1024;');
    expect(server).toContain('if (before.size > MAX_PREFLIGHT_REPORT_BYTES)');
    expect(server).toContain('const { bytesRead } = await handle.read(');
    expect(server).toContain('if (totalBytes > MAX_PREFLIGHT_REPORT_BYTES)');
    expect(server).toContain('const after = await handle.stat();');
    expect(server).toContain('after.size !== before.size || totalBytes !== before.size');
    expect(server).toContain('await handle.close().catch(() => {});');
    expect(server).not.toContain("await handle.readFile('utf8')");
    expect(server).not.toContain("import { lstat, readFile } from 'node:fs/promises';");
    expect(server).not.toContain("readFile(path, 'utf8')");
  });

  it('keeps the browser preflight response bounded before JSON parsing', () => {
    const runner = runnerSource();
    expect(runner).toContain('const MAX_PREFLIGHT_REPORT_BYTES = 16 * 1024 * 1024;');
    expect(runner).toContain('const preflightBytes = await readResponseBytesBounded(preflightResponse, {');
    expect(runner).toContain('maxBytes: MAX_PREFLIGHT_REPORT_BYTES,');
    expect(runner).toContain("url: './data/preflight.json',");
    expect(runner).toContain('const preflight = JSON.parse(new TextDecoder().decode(preflightBytes));');
    expect(runner).not.toContain('preflightResponse.json()');
  });

  it('keeps preflight validation before the HTTP server becomes listenable', () => {
    const server = serverSource();
    const descriptorRead = server.indexOf(
      "await readNonSymlinkJson(PREFLIGHT_REPORT, 'PREFLIGHT_REPORT')",
    );
    const validation = server.indexOf(
      'const preflight = validateEndpointEmbeddingEightPhysicalPreflightReport(',
    );
    const serverCreation = server.indexOf('const server = createServer(');
    expect(descriptorRead).toBeGreaterThanOrEqual(0);
    expect(validation).toBeGreaterThanOrEqual(0);
    expect(serverCreation).toBeGreaterThan(validation);
  });
});
