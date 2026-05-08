# クローラーから取得できる Unzen ページ設計

広告枠と違い、Unzen で生成したページ内容は検索エンジン、SNS preview、
リンク保存サービスなどのクローラーからも取得できる必要がある。
この文書は、fetch 専用サーバコンテナ + Unzen サイト構成を保ちながら、
クローラー向けに公開可能な内容を渡すための設計を定義する。

## 前提

通常の訪問者向けページでは、サーバコンテナは upstream fetch、cache、secret 境界、
Unzen manifest/code/worker 配信だけを担当し、表示用 view model 生成はブラウザ内の
Unzen function に委譲する。

クローラーは次の点で通常の訪問者と異なる。

- JavaScript 実行が遅延、制限、または無効になり得る
- Web Worker / Wasm 実行を前提にできない
- personalization やユーザー操作後の state を持たない
- index すべき内容と index してはいけない内容を明確に分ける必要がある

したがって、クローラー対応は「クローラーに Unzen browser sandbox を実行させる」
のではなく、「公開可能な snapshot をサーバから取得できる形で置く」ことで実現する。

## 基本方針

| 対象 | 返すもの | 生成場所 |
|---|---|---|
| Browser visitor | static shell + raw source fetch + Unzen browser view model | 訪問者ブラウザ |
| Search crawler | canonical HTML snapshot + structured data | build job または snapshot worker |
| SNS / link preview | title、description、OGP、代表画像 | metadata route / static snapshot |
| noindex page | static shell + `noindex` | server container |

クローラー向け snapshot は、ユーザーごとの private state を含まない public projection に
限定する。検索、並び替え、ランキングなどの個人化された結果は index しない。

## リクエストフロー

```text
Build job / scheduled snapshot worker
  | fetch public source through the same allowlisted upstream boundary
  v
Raw public source JSON
  |
  | run the same pure projection code as Unzen, outside request path
  v
Canonical page snapshot
  |
  | write immutable HTML / JSON-LD / OGP metadata artifact
  v
Static asset storage or server container cache

Crawler
  | GET /articles/example
  v
Server container
  | serve shell + canonical snapshot + structured data
  v
Crawler-visible HTML
```

ブラウザ訪問者は従来通り Unzen browser sandbox で最新の view model を作る。
クローラーは request-time に Unzen function を実行しない。

## Next.js App Router の構成

```text
app/
  articles/
    [slug]/
      page.tsx              # shell + crawler snapshot
      metadata.ts           # OGP / canonical / robots
  api/
    source/
      route.ts              # browser visitor 向け raw fetch
    crawler-snapshots/
      [slug]/
        route.ts            # public snapshot JSON for diagnostics
lib/
  crawler-snapshot.ts       # immutable public snapshot read only
  source.ts                 # upstream URL, cache, auth header
```

`page.tsx` は crawler-visible な最小 HTML を返す。ブラウザでは Client Component が
hydration 後に `/api/source` と Unzen function を使い、同じ領域を最新データで置き換える。

```tsx
import { FetchOnlyPage } from '@/app/components/FetchOnlyPage';
import { getCrawlerSnapshot } from '@/lib/crawler-snapshot';

export default async function ArticlePage({ params }: { params: { slug: string } }) {
  const snapshot = await getCrawlerSnapshot(params.slug);

  return (
    <main>
      <article>
        <h1>{snapshot.title}</h1>
        <p>{snapshot.description}</p>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(snapshot.jsonLd) }}
        />
      </article>
      <FetchOnlyPage snapshotId={snapshot.id} />
    </main>
  );
}
```

snapshot が存在しない、古すぎる、または private data を必要とするページでは、
canonical content を返さず `noindex` を明示する。

```tsx
import type { Metadata } from 'next';

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const snapshot = await getCrawlerSnapshot(params.slug);

  if (!snapshot.indexable) {
    return {
      robots: { index: false, follow: false },
    };
  }

  return {
    title: snapshot.title,
    description: snapshot.description,
    alternates: { canonical: snapshot.canonicalUrl },
    openGraph: {
      title: snapshot.title,
      description: snapshot.description,
      url: snapshot.canonicalUrl,
      images: snapshot.imageUrl ? [snapshot.imageUrl] : undefined,
    },
  };
}
```

## Snapshot の生成ルール

snapshot 生成は request-time server render に戻さない。次のどちらかに限定する。

1. build job で public source を取得し、静的 snapshot artifact を生成する
2. scheduled snapshot worker が public source を更新し、immutable version として保存する

snapshot artifact は次の metadata を持つ。

```typescript
type CrawlerSnapshot = {
  id: string;
  sourceVersion: string;
  projectionVersion: string;
  generatedAt: string;
  expiresAt: string;
  indexable: boolean;
  canonicalUrl: string;
  title: string;
  description: string;
  imageUrl?: string;
  jsonLd: Record<string, unknown>;
};
```

`projectionVersion` は Unzen function と同じ public projection code の version を示す。
これにより、ブラウザ表示と crawler snapshot が同じ意図の変換で作られていることを追跡できる。

## Index してよい内容

- public API、公開 CMS、公開商品データなど、誰に見せてもよい source
- personalization を含まない canonical title / description / body excerpt
- ページの主題、公開日時、著者、代表画像などの structured data
- Unzen function が最終表示で使う public projection の代表結果

## Index してはいけない内容

- ユーザー入力、ログイン状態、地域、AB test bucket に依存する結果
- secret 付き upstream response の private fields
- 訪問者ブラウザでしか検証できない opt-in / reward / 計算参加状態
- 最新性が重要で、古い snapshot が誤情報になるページ

## Fetch 専用構成との境界

クローラー対応のために、通常 request の server container へランキング計算や
Markdown 変換を戻してはいけない。server container が行うのは次に限る。

- snapshot artifact の読み出し
- canonical metadata / robots / JSON-LD の返却
- snapshot が使えない場合の `noindex`
- visitor browser 用の raw source fetch

計算済み snapshot の生成は build job または scheduled snapshot worker の責務にする。
これにより、通常アクセス時のサーバ CPU を増やさず、クローラーには取得可能な
canonical content を提供できる。

## 受け入れ条件

1. indexable page は JavaScript なしで title、description、canonical、JSON-LD を取得できる
2. browser visitor は hydration 後に Unzen browser sandbox で最新 view model を生成できる
3. snapshot artifact は sourceVersion、projectionVersion、generatedAt、expiresAt を持つ
4. private または personalized page は `noindex` を返す
5. server container は request-time の表示用集計、検索、並び替え、Markdown 変換を行わない
6. snapshot 生成失敗時は stale snapshot の許容時間か `noindex` fallback を明示する
