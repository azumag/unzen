import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleRoot = join(__dirname, '..');
const repoRoot = join(exampleRoot, '../../..');

async function readExampleFile(path: string): Promise<string> {
  return readFile(join(exampleRoot, path), 'utf8');
}

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
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

  it('serves and registers the client, execution worker, and cache worker', async () => {
    const script = await readExampleFile('scripts/copy-unzen-assets.mjs');
    const component = await readExampleFile('app/components/UnzenDemo.tsx');

    expect(script).toContain("index.browser.js'), join(publicDir, 'client.js')");
    expect(script).toContain("quickjs-worker.js'), join(publicDir, 'worker.js')");
    expect(script).toContain("unzen-cache-worker.js'),");
    expect(script).toContain("join(publicRoot, 'unzen-cache-worker.js')");
    expect(component).toContain("endpoint: '/api/unzen'");
    expect(component).toContain("workerUrl: '/unzen/worker.js'");
    expect(component).toContain('registerUnzenCacheWorker');
    expect(component).toContain("workerUrl: '/unzen-cache-worker.js'");
    expect(component).toContain('callWithDiagnostics');
  });

  it('documents and scripts the runtime E2E smoke test', async () => {
    const packageJson = JSON.parse(await readExampleFile('package.json'));
    const readme = await readExampleFile('README.md');
    const e2eScript = await readExampleFile('scripts/runtime-e2e.mjs');

    expect(packageJson.scripts['test:e2e']).toContain('scripts/runtime-e2e.mjs');
    expect(readme).toContain('npm run test:e2e');
    expect(e2eScript).toContain('/api/unzen/manifest');
    expect(e2eScript).toContain('/api/unzen/exec/jsonSchemaValidate');
    expect(e2eScript).toContain('/unzen/worker.js');
    expect(e2eScript).toContain('/unzen-cache-worker.js');
    expect(e2eScript).toContain(
      "import { UNZEN_CODE_CACHE_NAME } from '@unzen/client/browser'",
    );
    expect(e2eScript).toContain('caches.open(cacheName)');
    expect(e2eScript).toContain('context.setOffline(true)');
    expect(e2eScript).toContain("getByRole('button', { name: 'Run validation' })");
    expect(e2eScript).toContain("payload.diagnostics?.executedOn === 'browser'");
    expect(e2eScript).toContain('Next.js runtime E2E timed out');
    expect(e2eScript).toContain("import.meta.resolve('next/dist/bin/next')");
    expect(e2eScript).toContain("server.kill('SIGKILL')");
    expect(e2eScript).toContain("context.tracing.start({ screenshots: true, snapshots: true, sources: true })");
    expect(e2eScript).toContain("join(artifactDir, 'browser-failure.png')");
    expect(e2eScript).toContain("join(artifactDir, 'trace.zip')");
    expect(e2eScript).toContain('await context.tracing.stop()');
  });

  it('runs the runtime E2E smoke test from GitHub Actions', async () => {
    const workflow = await readRepoFile('.github/workflows/nextjs-runtime-e2e.yml');
    const readme = await readExampleFile('README.md');

    expect(workflow).toContain('Next.js Runtime E2E');
    expect(workflow).toContain("'core/packages/**'");
    expect(workflow).toContain("'core/examples/nextjs-app-router/**'");
    expect(workflow).toContain('npx playwright install --with-deps chromium');
    expect(workflow).toContain('npm run test:e2e');
    expect(workflow).toContain('if: failure()');
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('nextjs-runtime-e2e-artifacts');
    expect(readme).toContain('test-results/nextjs-runtime-e2e/browser-failure.png');
    expect(readme).toContain('npx playwright show-trace trace.zip');
    expect(readme).toContain('.github/workflows/nextjs-runtime-e2e.yml');
  });
});
