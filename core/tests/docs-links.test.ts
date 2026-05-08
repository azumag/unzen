import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

async function readCoreFile(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

describe('core documentation links', () => {
  it('surfaces the fetch-only container site architecture from the public docs', async () => {
    const readme = await readCoreFile('README.md');
    const index = await readCoreFile('docs/INDEX.md');
    const guide = await readCoreFile('docs/fetch-only-container-site.md');

    expect(readme).toContain('docs/fetch-only-container-site.md');
    expect(readme).toContain('Fetch 専用サーバコンテナ構成');
    expect(index).toContain('fetch-only-container-site.md');
    expect(guide).toContain('Server container');
    expect(guide).toContain('Unzen function');
    expect(guide).toContain("mode: 'browser-only'");
    expect(guide).toContain('/api/source');
    expect(guide).toContain('/api/unzen/manifest');
  });

  it('surfaces crawler-accessible Unzen page guidance from the public docs', async () => {
    const readme = await readCoreFile('README.md');
    const index = await readCoreFile('docs/INDEX.md');
    const guide = await readCoreFile('docs/crawler-accessible-unzen-pages.md');

    expect(readme).toContain('docs/crawler-accessible-unzen-pages.md');
    expect(readme).toContain('クローラーから取得できる Unzen ページ設計');
    expect(index).toContain('crawler-accessible-unzen-pages.md');
    expect(guide).toContain('canonical HTML snapshot');
    expect(guide).toContain('structured data');
    expect(guide).toContain('noindex');
    expect(guide).toContain('projectionVersion');
    expect(guide).toContain('server container は request-time');
  });
});
