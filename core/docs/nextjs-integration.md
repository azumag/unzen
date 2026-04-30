# Next.js App Router 統合ガイド

Next.js App Router では、Unzen の Hono middleware を Route Handler から呼び出すことで、
`@unzen/server` の manifest/code/fallback API を同じアプリ内に配置できる。

## 前提

- Next.js App Router を使う
- Runtime は Node.js を使う
- `@unzen/server` と `@unzen/client` をアプリにインストールする
- `@unzen/client` のブラウザ用 bundle と worker bundle を `public/` から配信する

Edge Runtime は現時点では対象外とする。`@unzen/server` は Node.js の
`crypto.createHash()` と QuickJS Wasm 初期化を使うため、Route Handler は
`runtime = 'nodejs'` を明示する。

## 構成

```text
app/
  api/
    unzen/
      [[...route]]/
        route.ts
  components/
    UnzenDemo.tsx
lib/
  unzen.ts
public/
  unzen/
    client.js
    worker.js
scripts/
  copy-unzen-assets.mjs
```

`/api/unzen/manifest`、`/api/unzen/code/:name`、`/api/unzen/exec/:name` を
Next.js の API Route から提供し、ブラウザ側の `UnzenClient` は同じ origin の
`/api/unzen` を endpoint として使う。

## サーバー設定

`UnzenServer` は QuickJS Runtime を初期化するため、リクエストごとに作らず
モジュールスコープで singleton 化する。

```typescript
// lib/unzen.ts
import { UnzenServer } from '@unzen/server';
import { Hono } from 'hono';

const baseUrl = process.env.NEXT_PUBLIC_UNZEN_BASE_URL ?? 'http://localhost:3000/api/unzen';

const server = new UnzenServer({ baseUrl });

server.defineRaw('jsonSchemaValidate', `function run(schema, data) {
  function validate(schema, value, path) {
    const errors = [];
    if (schema.type === 'object') {
      for (const key of schema.required ?? []) {
        if (value[key] === undefined) errors.push(path + '.' + key + ': required');
      }
    }
    return errors;
  }

  const errors = validate(schema, data, '$');
  return { valid: errors.length === 0, errors };
}`, { timeout: 500 });

let appPromise: Promise<Hono> | undefined;

export function getUnzenApp() {
  appPromise ??= (async () => {
    await server.initialize();

    const app = new Hono();
    app.route('/api/unzen', server.middleware());
    return app;
  })();

  return appPromise;
}
```

`define()` は `Function.toString()` で関数本文を取り出す。Next.js のビルド後コードでは
関数が変換されることがあるため、App Router 統合では `defineRaw()` で
実行したい `function run(...)` を明示する方法を推奨する。

## Route Handler

Hono app が持つ `fetch()` に Next.js の `Request` を渡す。
catch-all Route Handler にすることで、Unzen middleware 内の相対パスをそのまま使える。

```typescript
// app/api/unzen/[[...route]]/route.ts
import { getUnzenApp } from '@/lib/unzen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  const app = await getUnzenApp();
  return app.fetch(request);
}

export { handle as GET, handle as POST };
```

この Route Handler は以下を提供する。

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/unzen/manifest` | 関数一覧、hash、version、code URL を返す |
| GET | `/api/unzen/code/:name` | sandbox で実行する関数コードを返す |
| POST | `/api/unzen/exec/:name` | ブラウザ実行失敗時のサーバーフォールバック |

## ブラウザ bundle の配信

`@unzen/client` には npm consumer 向け entry と、ブラウザに直接配信しやすい
self-contained bundle がある。Next.js が worker bundle を静的配信できるように、
build 後の成果物を `public/unzen/` にコピーする。

```javascript
// scripts/copy-unzen-assets.mjs
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientDir = join(root, 'node_modules', '@unzen', 'client', 'dist');
const publicDir = join(root, 'public', 'unzen');

await mkdir(publicDir, { recursive: true });
await copyFile(join(clientDir, 'index.browser.js'), join(publicDir, 'client.js'));
await copyFile(join(clientDir, 'quickjs-worker.js'), join(publicDir, 'worker.js'));
```

```json
{
  "scripts": {
    "postinstall": "node scripts/copy-unzen-assets.mjs",
    "postbuild": "node scripts/copy-unzen-assets.mjs"
  }
}
```

実運用では `Cache-Control` を長めに設定した CDN/静的配信へ載せてもよい。
bundle 名に hash を付けない場合は、デプロイ時にキャッシュ破棄できる運用にする。

## React Client Component

`UnzenClient` は Web Worker を生成するため、Client Component 内で初期化する。
`workerUrl` は `public/` から配信した worker bundle を指す。

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import type { UnzenClient as UnzenClientType } from '@unzen/client/browser';

export function UnzenDemo() {
  const [client, setClient] = useState<UnzenClientType | null>(null);
  const [result, setResult] = useState<string>('');

  const schema = useMemo(() => ({
    type: 'object',
    required: ['email'],
  }), []);

  useEffect(() => {
    let active = true;
    let instance: UnzenClientType | undefined;

    async function load() {
      const mod = await import(/* webpackIgnore: true */ '/unzen/client.js');
      instance = new mod.UnzenClient({
        endpoint: '/api/unzen',
        mode: 'production',
        workerUrl: '/unzen/worker.js',
      });
      if (active) setClient(instance);
    }

    void load();

    return () => {
      active = false;
      instance?.dispose();
    };
  }, []);

  async function validate() {
    if (!client) return;
    const response = await client.call('jsonSchemaValidate', schema, { email: 'a@example.com' });
    setResult(JSON.stringify(response, null, 2));
  }

  return (
    <section>
      <button type="button" onClick={validate} disabled={!client}>
        Validate
      </button>
      <pre>{result}</pre>
    </section>
  );
}
```

アプリの bundler に `@unzen/client` を直接解決させたい場合でも、worker script は
通常の ESM import ではなく `workerUrl` として渡す必要がある。

## Runtime とセキュリティ上の注意

- Route Handler は Node.js Runtime に固定する
- `UnzenServer` は singleton にして、QuickJS Wasm 初期化を重複させない
- `defineRaw()` に渡すコードは純粋計算に限定する
- sandbox 内では `fetch`、`WebSocket`、DOM API、dynamic import は使えない
- function error はフォールバックしない。runtime error のみ server fallback する
- `browser-only` mode を使うと server fallback せず、ブラウザ実行失敗をそのまま返す

## 動作確認

開発サーバー起動後、まず API が返ることを確認する。

```bash
curl http://localhost:3000/api/unzen/manifest
```

ブラウザ側では `callWithDiagnostics()` を使うと、実行場所が browser か server かを確認できる。

```typescript
const response = await client.callWithDiagnostics('jsonSchemaValidate', schema, data);
console.log(response);
```

`executedOn: 'browser'` なら QuickJS Web Worker で実行されている。
`executedOn: 'server'` なら runtime error から server fallback しているため、
worker URL、CSP、Wasm 読み込み、ブラウザ互換性を確認する。
