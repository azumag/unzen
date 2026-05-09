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

  it('surfaces ad opt-out participation guidance from the public docs', async () => {
    const readme = await readCoreFile('README.md');
    const index = await readCoreFile('docs/INDEX.md');
    const guide = await readCoreFile('docs/ad-opt-out-participation.md');

    expect(readme).toContain('docs/ad-opt-out-participation.md');
    expect(readme).toContain('広告オプトアウトを選べる Unzen ページ設計');
    expect(index).toContain('ad-opt-out-participation.md');
    expect(guide).toContain("adsConsent: 'accepted' | 'opted-out' | 'unknown'");
    expect(guide).toContain("computeParticipation: 'enabled' | 'disabled'");
    expect(guide).toContain('広告 SDK、広告計測、広告 iframe');
    expect(guide).toContain('Crawler snapshot は広告同意状態を持たない');
    expect(guide).toContain('server container は広告同意処理を追加しても');
  });
});
