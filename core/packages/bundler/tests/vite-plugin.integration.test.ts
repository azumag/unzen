import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { unzenVitePlugin } from '../src/vite-plugin';

describe('unzenVitePlugin with Vite', () => {
  it('extracts a typed definition during a real library build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'unzen-vite-'));
    const entry = join(root, 'functions.ts');
    writeFileSync(entry, `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('double', (value: number): number => value * 2);
export { server };`);

    try {
      const buildResult = await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [unzenVitePlugin()],
        build: {
          write: false,
          minify: false,
          lib: { entry, formats: ['es'] },
          rollupOptions: { external: ['@unzen/server'] },
        },
      });
      const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
      const generated = outputs.flatMap((output) => (
        'output' in output ? output.output : []
      ));
      const chunk = generated.find((item) => item.type === 'chunk');

      expect(chunk?.type).toBe('chunk');
      expect(chunk && chunk.type === 'chunk' ? chunk.code : '').toContain('server.defineRaw');
      expect(chunk && chunk.type === 'chunk' ? chunk.code : '').not.toContain('value: number');
      expect(chunk && chunk.type === 'chunk' ? chunk.code : '').toContain('(value) => value * 2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
