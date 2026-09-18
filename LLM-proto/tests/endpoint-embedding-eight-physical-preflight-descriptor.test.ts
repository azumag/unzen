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

function budgetSource() {
  return readFileSync(
    new URL('../browser-harness/endpoint-embedding-eight-physical-webgpu/preflight-budget.js', import.meta.url),
    'utf8',
  );
}

describe('8-physical endpoint preflight descriptor binding', () => {
  it('reads the preflight JSON only from the accepted FileHandle and keeps the host allocation bounded', () => {
    const server = serverSource();
    expect(server).toContain('openExistingNonSymlinkFile,');
    expect(server).toContain('readBoundedUtf8FileHandle,');
    expect(server).toContain(
      "import { ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT_MAX_BYTES } from './preflight-budget.js';",
    );
    expect(server).toContain(
      'const { handle, info: before } = await openNonSymlinkFileForField(path, field);',
    );
    expect(server).toContain('const text = await readBoundedUtf8FileHandle(handle, before, {');
    expect(server).toContain('maxBytes: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT_MAX_BYTES,');
    expect(server).not.toContain('const MAX_PREFLIGHT_REPORT_BYTES =');
    expect(server).toContain('await handle.close().catch(() => {});');
    expect(server).not.toContain("await handle.readFile('utf8')");
    expect(server).not.toContain("import { lstat, readFile } from 'node:fs/promises';");
    expect(server).not.toContain("readFile(path, 'utf8')");
  });

  it('keeps one shared preflight ceiling for the host and browser paths', () => {
    const budget = budgetSource();
    const runner = runnerSource();
    expect(budget).toContain(
      'export const ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT_MAX_BYTES = 16 * 1024 * 1024;',
    );
    expect(runner).toContain(
      "import { ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT_MAX_BYTES } from './preflight-budget.js';",
    );
    expect(runner).not.toContain('const MAX_PREFLIGHT_REPORT_BYTES =');
  });

  it('keeps the browser preflight response bounded before JSON parsing', () => {
    const runner = runnerSource();
    expect(runner).toContain('const preflightBytes = await readResponseBytesBounded(preflightResponse, {');
    expect(runner).toContain('maxBytes: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT_MAX_BYTES,');
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
