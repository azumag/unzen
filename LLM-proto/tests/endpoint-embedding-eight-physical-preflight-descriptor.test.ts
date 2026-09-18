import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function serverSource() {
  return readFileSync(
    new URL('../browser-harness/endpoint-embedding-eight-physical-webgpu/serve.mjs', import.meta.url),
    'utf8',
  );
}

describe('8-physical endpoint preflight descriptor binding', () => {
  it('reads the preflight JSON only from the accepted FileHandle', () => {
    const server = serverSource();
    expect(server).toContain(
      "import { openExistingNonSymlinkFile } from '../webgpu-2b-split/server-safe-path.mjs';",
    );
    expect(server).toContain(
      'const { handle, info: before } = await openNonSymlinkFileForField(path, field);',
    );
    expect(server).toContain("const text = await handle.readFile('utf8');");
    expect(server).toContain('const after = await handle.stat();');
    expect(server).toContain("Buffer.byteLength(text, 'utf8') !== before.size");
    expect(server).toContain('await handle.close().catch(() => {});');
    expect(server).not.toContain("import { lstat, readFile } from 'node:fs/promises';");
    expect(server).not.toContain("readFile(path, 'utf8')");
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
