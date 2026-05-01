import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleRoot = join(__dirname, '..');

async function readExampleFile(path: string): Promise<string> {
  return readFile(join(exampleRoot, path), 'utf8');
}

describe('Next.js App Router example', () => {
  it('mounts Unzen middleware below /api/unzen in the Hono app', async () => {
    const source = await readExampleFile('lib/unzen.ts');

    expect(source).toContain("new UnzenServer({ baseUrl })");
    expect(source).toContain('const unzenMiddleware = server.middleware()');
    expect(source).toContain("app.route('/api/unzen', unzenMiddleware)");
  });

  it('forwards catch-all route handler requests to Hono fetch', async () => {
    const source = await readExampleFile('app/api/unzen/[[...route]]/route.ts');

    expect(source).toContain("export const runtime = 'nodejs'");
    expect(source).toContain('return app.fetch(request)');
    expect(source).toContain('export { handle as GET, handle as POST }');
  });

  it('serves the browser client and QuickJS worker from public assets', async () => {
    const script = await readExampleFile('scripts/copy-unzen-assets.mjs');
    const component = await readExampleFile('app/components/UnzenDemo.tsx');

    expect(script).toContain("index.browser.js'), join(publicDir, 'client.js')");
    expect(script).toContain("quickjs-worker.js'), join(publicDir, 'worker.js')");
    expect(component).toContain("endpoint: '/api/unzen'");
    expect(component).toContain("workerUrl: '/unzen/worker.js'");
    expect(component).toContain('callWithDiagnostics');
  });
});
