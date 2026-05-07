# Fetch 専用サーバコンテナ + Unzen サイト構成

サーバコンテナを「外部 API への fetch と静的アセット配信だけ」に絞り、
レンダリング前の整形、フィルタリング、集計、表示用 view model 生成を
Unzen のブラウザ sandbox に委譲する構成を定義する。

この構成の目的は、サイトごとのサーバ CPU 消費を増やさずに、外部データを使う
動的ページを作ることにある。サーバはネットワーク境界と secret 境界を担当し、
ユーザーごとの内部計算は訪問者のブラウザで完結させる。

## 責務分離

| レイヤー | 担当すること | 担当しないこと |
|---|---|---|
| Server container | upstream fetch、認証ヘッダー付与、rate limit、cache、Unzen manifest/code/worker 配信 | HTML 生成、ランキング計算、フィルタリング、Markdown 変換、集計 |
| Unzen function | 正規化、並び替え、検索、集計、表示用 view model 生成、軽量 Markdown 変換 | fetch、secret 参照、DOM 操作、永続書き込み |
| React/browser UI | DOM レンダリング、ユーザー操作、UnzenClient 呼び出し、結果表示 | secret を使う fetch、信頼境界を越える検証 |

「レンダリングを Unzen に任せる」は DOM を sandbox から直接触る意味ではない。
Unzen は `CardViewModel[]` や sanitized HTML string のような表示可能なデータを返し、
React などの UI 層が最終的な DOM を描画する。

## リクエストフロー

```text
Browser UI
  | GET /api/source?cursor=...
  v
Server container
  | fetch upstream with secrets, cache, and rate limits
  v
Raw source JSON
  |
  | client.call('buildPageViewModel', rawJson, userFilters)
  v
Unzen browser sandbox
  |
  v
View model / sanitized HTML fragments
  |
  v
Browser UI renders DOM
```

Unzen の manifest/code/worker は通常の Next.js 統合と同じく `/api/unzen` と
`/unzen/worker.js` から配信する。サーバコンテナの fetch route は外部データを
生に近い形で返し、ページ固有の整形ロジックを持たない。

## Next.js App Router での最小構成

```text
app/
  api/
    source/
      route.ts              # fetch only
    unzen/
      [[...route]]/
        route.ts            # Unzen manifest/code/exec
  components/
    FetchOnlyPage.tsx       # Client Component
lib/
  source.ts                 # upstream URL, cache, auth header
  unzen.ts                  # UnzenServer singleton
public/
  unzen/
    client.js
    worker.js
```

`app/api/source/route.ts` は upstream fetch のみに限定する。

```typescript
import { fetchSource } from '@/lib/source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const response = await fetchSource({ cursor });

  return Response.json(response, {
    headers: {
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300',
    },
  });
}
```

`FetchOnlyPage.tsx` は fetch 結果を受け取り、Unzen function で表示用データへ変換する。

```tsx
'use client';

import { useEffect, useState } from 'react';
import type { UnzenClient as UnzenClientType } from '@unzen/client/browser';

type SourceItem = {
  title: string;
  tags: string[];
  score: number;
  body: string;
};

type CardViewModel = {
  title: string;
  excerpt: string;
  badge: string;
};

export function FetchOnlyPage() {
  const [client, setClient] = useState<UnzenClientType | null>(null);
  const [cards, setCards] = useState<CardViewModel[]>([]);

  useEffect(() => {
    let disposed = false;
    let instance: UnzenClientType | undefined;

    async function boot() {
      const mod = await import(/* webpackIgnore: true */ '/unzen/client.js');
      instance = new mod.UnzenClient({
        endpoint: '/api/unzen',
        mode: 'browser-only',
        workerUrl: '/unzen/worker.js',
      });
      if (!disposed) setClient(instance);
    }

    void boot();

    return () => {
      disposed = true;
      instance?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!client) return;

    async function load() {
      const source = await fetch('/api/source').then((response) => response.json());
      const viewModel = await client.call('buildPageViewModel', source.items, {
        minScore: 50,
        tag: 'featured',
      });
      setCards(viewModel as CardViewModel[]);
    }

    void load();
  }, [client]);

  return (
    <main>
      {cards.map((card) => (
        <article key={card.title}>
          <span>{card.badge}</span>
          <h2>{card.title}</h2>
          <p>{card.excerpt}</p>
        </article>
      ))}
    </main>
  );
}
```

`browser-only` mode を使うと、Unzen function が失敗したときにサーバ実行へ戻らない。
fetch 専用サーバコンテナを守る場合はこの mode を基本にする。

## Unzen function の形

```typescript
unzen.defineRaw('buildPageViewModel', `function run(items, options) {
  return items
    .filter(function (item) {
      return item.score >= options.minScore && item.tags.indexOf(options.tag) !== -1;
    })
    .sort(function (a, b) {
      return b.score - a.score;
    })
    .map(function (item) {
      var body = String(item.body || '');
      return {
        title: String(item.title || ''),
        excerpt: body.length > 140 ? body.slice(0, 137) + '...' : body,
        badge: item.score >= 90 ? 'top' : 'featured'
      };
    });
}`, { timeout: 500 });
```

関数は純粋計算に限定する。入力は fetch route から取得した JSON とユーザー操作由来の
filter/sort 条件だけにする。

## 向いているページ

- ニュース、商品、記事、求人などの一覧ページ
- API から取得したデータの並び替え、絞り込み、ランキング表示
- Markdown や軽量 DSL から sanitized HTML fragment を作るページ
- ユーザーごとに表示条件が変わるが、secret が不要な計算

## 向いていないページ

- SEO のために完全な SSR HTML が必須のページ
- payment、認可、在庫確保など、サーバ側の信頼境界で確定すべき処理
- 外部 API への追加 fetch が計算中に必要な処理
- DOM API、WebSocket、IndexedDB など副作用を Unzen function 内で必要とする処理

## セキュリティと運用条件

- secret は server container から外に出さない
- fetch route は upstream allowlist、timeout、response size limit を持つ
- Unzen function は `browser-only` を基本にし、server fallback を使う場合は明示的に許可する
- source JSON は schema/version を持ち、Unzen function は未知の version を失敗させる
- 表示用 HTML を返す場合は sanitizer を function 内に含め、React 側では `dangerouslySetInnerHTML` の使用箇所を限定する
- route と function の責務が混ざらないよう、fetch route のテストでは変換ロジックがないことを確認する

## 受け入れ条件

この構成でサイトを作れる状態とみなす条件は次の通り。

1. `/api/source` は upstream fetch、cache、認証ヘッダー付与だけを担当する
2. `/api/unzen/manifest` と `/api/unzen/code/:name` から変換関数を配信できる
3. Client Component は `/api/source` の raw JSON を受け取り、Unzen で view model に変換する
4. 変換、検索、並び替え、集計、表示用 fragment 生成がサーバ route に存在しない
5. Unzen failure 時の UI 表示と retry 導線が定義されている
6. SEO が必要なページでは、静的 shell と noindex/structured data の方針を別途決める
