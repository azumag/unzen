# QJS-proto E2E Demo

QuickJS Wasm サンドボックスによるブラウザ側関数実行のデモ。4層隔離モデルの動作を確認できる。

## デモ関数 (8種)

### 基本デモ
1. **Spam Detection** - テキストのスパム判定
2. **Math Operations** - 数値の乗算
3. **Array Transformations** - 配列要素の倍化
4. **Object Manipulation** - ユーザー情報変換

### 実用デモ (サーバー委任パターン)
5. **Form Validation** - メール/クレジットカード/電話番号/パスワードの改竄不能バリデーション
6. **Price Calculator** - 税金・割引・送料の改竄不能な価格計算
7. **Markdown to HTML** - SSR Markdown レンダリングのクライアントオフロード
8. **Text Statistics** - 単語数・可読性スコア・Flesch-Kincaid指標

## 起動方法

```bash
# プロジェクトルートから
npm install
npm run build

# デモサーバー起動
cd demo
npm install
npm run dev
# → http://localhost:3000
```

## アーキテクチャ

```
Browser Main Thread                  Web Worker Thread
┌─────────────────────┐             ┌──────────────────────────┐
│ UnzenClient         │  postMsg    │ Layer 1: Web Worker      │
│  └─ WebWorkerSandbox├────────────►│  └─ Layer 2: Wasm sandbox│
│     Executor        │◄────────────┤     └─ Layer 3: QuickJS  │
│     (timeout guard) │  postMsg    │        └─ Layer 4: API制限│
└─────────────────────┘             └──────────────────────────┘
                           ↕ HTTP (fallback only)
┌─────────────────────────────────────────────────────────────┐
│                    Server (Node.js + Hono)                   │
│  @unzen/server                                              │
│  ├─ Function Registry (defineRaw)                           │
│  ├─ Manifest Builder                                        │
│  ├─ QuickJS Runtime (fallback execution)                    │
│  ├─ Worker bundle (GET /worker.js)                          │
│  └─ HTTP Routes                                             │
│     ├─ GET /manifest (function metadata + hash)             │
│     ├─ GET /code/:name (function source code)               │
│     └─ POST /exec/:name (fallback execution)                │
└─────────────────────────────────────────────────────────────┘
```

## 実行フロー

1. **クライアント初期化**: `new UnzenClient({ endpoint, workerUrl: '/worker.js' })`
2. **関数呼び出し**: `client.call('spamCheck', text)`
3. **マニフェスト取得**: `GET /unzen/manifest` で関数一覧取得
4. **コード取得**: `GET /unzen/code/spamCheck` でソースコード取得
5. **ブラウザ実行**: Web Worker 内の QuickJS Wasm サンドボックスで実行
6. **フォールバック**: ブラウザ実行失敗時のみ `POST /unzen/exec/spamCheck`

## コード例

### サーバー側 (server.ts)

```typescript
import { UnzenServer } from '@unzen/server';
import { Hono } from 'hono';

const app = new Hono();
const unzen = new UnzenServer({ baseUrl: 'http://localhost:3000/unzen' });

unzen.defineRaw('spamCheck', `function run(text) {
  const patterns = [/viagra/i, /casino/i, /lottery/i];
  return patterns.some(p => p.test(text));
}`);

await unzen.initialize();
app.route('/unzen', unzen.createRoutes());
```

### クライアント側 (demo.js)

```typescript
import { UnzenClient } from '/client.js';

const client = new UnzenClient({
  endpoint: 'http://localhost:3000/unzen',
  mode: 'production',
  workerUrl: '/worker.js', // QuickJS Wasm サンドボックス
});

const isSpam = await client.call('spamCheck', 'Buy now!');
```

## API エンドポイント

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/unzen/manifest` | GET | 登録関数のメタデータ (名前, ハッシュ) |
| `/unzen/code/:name` | GET | 関数ソースコード |
| `/unzen/exec/:name` | POST | サーバー側フォールバック実行 |
| `/worker.js` | GET | QuickJS Wasm Worker バンドル (778KB) |
| `/client.js` | GET | クライアントSDKバンドル |

## セキュリティ

関数は4層隔離サンドボックス内で実行:
- **Layer 1**: Web Worker (別スレッド、DOM アクセス不可)
- **Layer 2**: Wasm sandbox (メモリ隔離)
- **Layer 3**: QuickJS interpreter (V8 とは別の JS エンジン)
- **Layer 4**: API 制限 (eval/Function/Proxy 削除、プロトタイプ凍結)

制約:
- 外部接続禁止 (fetch, WebSocket, XHR 等)
- メモリ制限: 16MB
- タイムアウト: 5000ms (ブラウザ側) / 50ms (サーバー側)
- 純粋計算のみ (入力→計算→出力、副作用なし)

## フォールバックテスト

サーバーフォールバックを確認するには:
1. DevTools の Network タブを開く
2. 関数を実行 → POST リクエストが発生しないことを確認 (ブラウザ実行成功)
3. Worker の初期化をブロック → POST /exec リクエストが発生 (サーバーフォールバック)
