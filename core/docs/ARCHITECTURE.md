# unzen core Phase 1 MVP アーキテクチャ・実装ドキュメント

**バージョン**: 1.1
**作成日**: 2026-02-07
**テスト**: 239 tests passing (shared:37 + server:61 + client:55 + demo:21 + samples:65)

---

## 1. コンセプト

サーバーサイドで定義した純粋関数を、訪問者のブラウザ内で実行するフレームワーク。
訪問者は自分自身が必要とする計算を、サーバーではなくブラウザ側のWasmサンドボックスで処理する。

```
従来:  訪問者 → サーバーAPI → サーバーで計算 → 結果返却
unzen: 訪問者 → ブラウザ内 QuickJS Wasm で計算 → 結果をそのまま利用
                （失敗時のみサーバーにフォールバック）
```

---

## 2. パッケージ構成

```
core/
├── packages/
│   ├── shared/   @unzen/shared   共通型・エラー・プロトコル定義
│   ├── server/   @unzen/server   サーバーSDK (Hono + QuickJS)
│   └── client/   @unzen/client   クライアントSDK (ブラウザ実行)
├── demo/                          統合デモ (Honoサーバー + HTMLページ)
├── package.json                   npm workspaces monorepo
├── vitest.config.ts               テスト設定 (全パッケージ共通)
└── tsconfig.base.json             TypeScript基本設定
```

### 依存関係

```
@unzen/shared  ← 依存なし (純粋型定義)
     ↑ (依存)
     ├── @unzen/server  ← hono, quickjs-emscripten
     │        ↑ (依存)
     └── @unzen/client  ← 依存なし (ブラウザAPI利用)
              ↑ (依存)
           demo/  ← @hono/node-server, @unzen/server
```

注: 矢印 ↑ は「依存している」を示す。demo/ は server と client の両方を使用。

---

## 3. 全体アーキテクチャ

### 3.1 実行フロー

```
┌─────────────────────────────────────────────────────────────────┐
│  サイトオーナーのサーバー                                         │
│                                                                 │
│  UnzenServer                                                    │
│  ├── defineRaw('spamCheck', '(text) => /spam/i.test(text)')     │
│  │   └── コードラップ: function run(...args) { return (CODE)(...args); }
│  │   └── SHA-256ハッシュ生成 + バージョン番号付与                  │
│  │   └── FunctionRegistry に登録                                 │
│  │                                                              │
│  ├── GET /unzen/manifest  → 全関数のメタデータJSON                │
│  ├── GET /unzen/code/:name → ラップ済み関数コード (immutable cache)│
│  └── POST /unzen/exec/:name → フォールバック実行 (QuickJS Wasm)   │
│                                                                 │
│  QuickJSRuntime (サーバー起動時に1度だけWasm初期化)                │
│  └── 毎リクエスト: 新コンテキスト作成 → eval/Function削除          │
│      → メモリ16MB制限 → タイムアウト50ms → 実行 → dispose         │
└─────────────────────────────────────────────────────────────────┘
                    ↕ HTTP (JSON)
┌─────────────────────────────────────────────────────────────────┐
│  訪問者のブラウザ                                                │
│                                                                 │
│  UnzenClient({ endpoint, mode })                                │
│  ├── ManifestFetcher → GET /manifest (インメモリキャッシュ)        │
│  ├── CodeFetcher → GET /code/:name (ハッシュベースキャッシュ)      │
│  ├── SandboxExecutor → ブラウザ内実行                             │
│  │   └── MVP: MockSandboxExecutor (Node.js vm)                  │
│  │   └── Phase 2: WebWorkerSandboxExecutor (QuickJS Wasm)       │
│  └── FallbackHandler → POST /exec/:name (サーバー実行)            │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 実行モード

| モード | ブラウザ実行 | フォールバック | 用途 |
|--------|------------|--------------|------|
| `development` | しない | 常にサーバー | デバッグ・高速イテレーション |
| `production` | する | RuntimeErrorのみ | 本番運用 |
| `browser-only` | する | しない | テスト・ベンチマーク |

### 3.3 エラーとフォールバック判定

```
UnzenFunctionError (ユーザーコードのバグ)
  → フォールバックしない。呼び出し元にスロー。
  → HTTP 400

UnzenRuntimeError (環境問題: タイムアウト、メモリ超過)
  → productionモードでフォールバック。
  → HTTP 500

UnzenNetworkError (通信失敗)
  → リトライ可能。
```

**設計意図**: ユーザーコードのバグをフォールバックでマスクしない。
サーバーで実行しても同じバグが発生するため、フォールバックは無意味である。

---

## 4. @unzen/shared (共通基盤)

### 4.1 型定義 (types.ts)

```typescript
// サポートするランタイム (Phase 1: quickjs のみ, Phase 2: moonbit 追加)
type RuntimeType = 'quickjs' | 'moonbit';

// 型ガード関数
function isRuntimeType(value: unknown): value is RuntimeType;

// 関数定義メタデータ (サーバー内部で保持。コード本体を含む)
interface FunctionDefinition {
  name: string;          // 一意の関数識別子
  runtime: RuntimeType;  // 実行ランタイム
  code: string;          // ラップ済み関数コード文字列 (run()ラッパー含む)
  version: number;       // キャッシュ無効化用バージョン (インメモリカウンタ)
  hash: string;          // SHA-256ハッシュ (整合性検証, 'sha256:' prefix)
}

// FunctionDefinition バリデーション関数
// 全フィールドの存在・型・値の妥当性を検証
function isValidFunctionDefinition(def: unknown): def is FunctionDefinition;

// マニフェストで公開される関数エントリ (コード本体を含まない)
// FunctionDefinition との違い: code フィールドの代わりに codeUrl を持つ
interface FunctionManifestEntry {
  runtime: RuntimeType;  // 実行ランタイム
  hash: string;          // SHA-256ハッシュ
  version: number;       // バージョン
  codeUrl: string;       // コード取得URL (絶対URL)
}

// 実行オプション
interface ExecutionOptions {
  timeout?: number;       // タイムアウト (ms, デフォルト 50)
  diagnostics?: boolean;  // 診断情報有効化
  mode?: 'production' | 'development' | 'browser-only';
}

// 診断付き実行結果
interface ExecutionResult<T = unknown> {
  value: T;                       // 関数戻り値
  executedOn: 'browser' | 'server';  // 実行場所
  runtime: RuntimeType;           // 使用ランタイム
  durationMs: number;             // 実行時間
  cached: boolean;                // コードキャッシュヒット有無 (CodeFetcher層)
}
```

**注意: FunctionDefinition と FunctionManifestEntry の違い**

サーバー内部では `FunctionDefinition` (コード本体含む) を保持するが、
マニフェストAPIでは `FunctionManifestEntry` (コードURLのみ) を公開する。
これにより、マニフェスト取得時に全コードをダウンロードする必要がない。

### 4.2 エラー階層 (errors.ts)

```
Error
 └── UnzenError (code: string)          ← 基底クラス。codeプロパティで判別共用体パターン
      ├── UnzenRuntimeError             ← code: 'RUNTIME_ERROR'
      │   フォールバック対象。タイムアウト、メモリ超過、Wasmロード失敗
      ├── UnzenFunctionError            ← code: 'FUNCTION_ERROR'
      │   フォールバックしない。ユーザー関数内のthrow、型エラー、未定義関数呼出
      └── UnzenNetworkError             ← code: 'NETWORK_ERROR'
          通信失敗。マニフェスト取得失敗、コード取得失敗、サーバーHTTPエラー
```

**設計意図**:
- `code` プロパティで `instanceof` なしの判別ができる
- V8の `Error.captureStackTrace` を使用して適切なスタックトレースを保持する

**エラー分類の重要な詳細**:
- QuickJSRuntime: 未知のエラーは `UnzenFunctionError` としてラップする (ユーザーコードが原因と推定するため)
- FallbackHandler: HTTP 4xx + error body → `UnzenFunctionError` (リトライ不可)
  HTTP 5xx + error body → `UnzenNetworkError` (リトライ可)
  body解析不可 → `UnzenNetworkError`

### 4.3 通信プロトコル (protocol.ts)

#### マニフェスト (GET /manifest)

```json
{
  "functions": {
    "spamCheck": {
      "runtime": "quickjs",
      "hash": "sha256:abc123...",
      "version": 1,
      "codeUrl": "http://localhost:3000/unzen/code/spamCheck?v=1"
    }
  }
}
```

#### 関数コード (GET /code/:name)

```javascript
function run(...args) { return ((text) => /spam/i.test(text))(...args); }
```

- `Content-Type: text/javascript`
- `Cache-Control: public, max-age=31536000, immutable`

#### フォールバック実行 (POST /exec/:name)

リクエスト:
```json
{ "args": ["test message"] }
```

成功レスポンス:
```json
{ "result": true }
```

エラーレスポンス:
```json
{ "result": null, "error": "Function execution failed: ..." }
```

---

## 5. @unzen/server (サーバーSDK)

### 5.1 コンポーネント構成

```
UnzenServer
 ├── FunctionRegistry    関数定義のインメモリMap (O(1)検索)
 ├── ManifestBuilder     Registry → ManifestResponse 変換
 └── QuickJSRuntime      QuickJS Wasm フォールバック実行エンジン
```

### 5.2 関数登録とコードラップ

```typescript
// 開発者が書くコード
server.defineRaw('add', `(a, b) => a + b`);

// 内部でラップされる
// → function run(...args) { return ((a, b) => a + b)(...args); }

// ラップの理由:
// 1. クライアントサンドボックスが run() 関数を呼ぶ統一規約
// 2. アロー関数、function式、宣言など任意の形式をサポート
// 3. 引数渡しを ...args で標準化
```

ラップ後のコードに対して SHA-256 ハッシュを生成し、バージョン番号を付与する。

### 5.3 QuickJS サンドボックス実行エンジン

フォールバック実行時のサーバーサイド QuickJS の動作:

```
1. initialize() → getQuickJS() で Wasm モジュールをロード (起動時1回)
2. execute(code, args) →
   a. newContext() → 新しい QuickJS コンテキスト作成
   b. setMemoryLimit(16MB) → メモリ上限設定
   c. evalCode → Object.defineProperty で eval/Function/Proxy/Reflect を
      undefined化 (configurable:false) + 主要プロトタイプ凍結
   d. evalCode(code) → ユーザーコード (run関数) をロード
   e. evalCode('globalThis.__args__ = [...]')
      → 引数をJSON経由で注入
      → 制約: undefined は null に変換される (JSON.stringify の仕様)
   f. setInterruptHandler → 50msタイムアウト設定
      → タイムアウト検出: interruptHandler + 'interrupted'文字列チェックの二重判定
   g. evalCode('run(...globalThis.__args__)') → 実行
   h. dump(result) → JS値に変換
   i. context.dispose() → メモリ解放 (finally)
```

**セキュリティ制約**:

| 制約 | 値 | 実装方法 |
|------|-----|---------|
| メモリ制限 | 16MB | `context.runtime.setMemoryLimit()` |
| タイムアウト | 50ms | `context.runtime.setInterruptHandler()` |
| eval禁止 | undefined化 | `Object.defineProperty(configurable:false)` |
| Function禁止 | undefined化 | `Object.defineProperty(configurable:false)` |
| Proxy禁止 | undefined化 | `Object.defineProperty(configurable:false)` |
| Reflect禁止 | undefined化 | `Object.defineProperty(configurable:false)` |
| プロトタイプ凍結 | 6種類 | `Object.freeze()` (Object/Array/String/Number/Boolean/RegExp) |
| コンテキスト隔離 | 毎回新規 | `this.quickJS.newContext()` |

**メモリ管理**: QuickJS は C ベースのメモリモデルのため、`.dispose()` が必須である。
`evalCode()` の戻り値 (`result.value`, `result.error`) はすべて明示的に dispose する。
コンテキスト全体は `finally` ブロックで確実に dispose する。

**エラーラッピング規則**: catch 内で `UnzenRuntimeError` / `UnzenFunctionError` はそのまま再throwする。
未知のエラーは `UnzenFunctionError` としてラップする (ユーザーコードが原因と推定するため)。

**`dispose()` メソッド**: `quickJS` を null に設定する。以降の `execute()` 呼出は
`UnzenRuntimeError('QuickJS runtime not initialized')` をスローする。

### 5.4 HTTP API

Hono ミドルウェアとして3つのエンドポイントを提供:

| メソッド | パス | レスポンス | ステータスコード |
|---------|------|----------|---------------|
| GET | /manifest | ManifestResponse (JSON) | 200 |
| GET | /code/:name | 関数コード (text/javascript) | 200, 404 |
| POST | /exec/:name | ExecutionResponse (JSON) | 200, 400, 404, 500 |

エラー時のHTTPステータスコード:
- **400**: `UnzenFunctionError` (ユーザーコードのバグ)
- **404**: 関数が見つからない
- **500**: `UnzenRuntimeError` (タイムアウト等) またはその他

---

## 6. @unzen/client (クライアントSDK)

### 6.1 コンポーネント構成

```
UnzenClient
 ├── ManifestFetcher     GET /manifest (インメモリキャッシュ)
 ├── CodeFetcher         GET /code/:name (ハッシュベースキャッシュ)
 ├── SandboxExecutor     ブラウザ内サンドボックス実行
 │    └── MockSandboxExecutor (MVP: Node.js vm)
 └── FallbackHandler     POST /exec/:name (サーバーフォールバック)
```

### 6.2 call() / callWithDiagnostics() メソッド

#### call() 実行フロー

```
call(name, ...args)
│
├── [development モード]
│   └── FallbackHandler.execute(name, args)
│       └── POST /exec/:name → サーバーで実行
│
├── [production モード]
│   ├── executeBrowser(name, args)
│   │   ├── ManifestFetcher.fetch() → マニフェスト取得 (キャッシュ)
│   │   ├── manifest.functions[name] → エントリ検索
│   │   │   └── 無い場合: throw UnzenFunctionError (フォールバックしない)
│   │   ├── CodeFetcher.fetch(entry) → コード取得 (ハッシュキャッシュ)
│   │   └── SandboxExecutor.execute(code, args) → ブラウザ実行
│   │
│   ├── [UnzenFunctionError] → そのまま throw (フォールバックしない)
│   └── [その他エラー] → FallbackHandler.execute() (フォールバック)
│
└── [browser-only モード]
    └── executeBrowser(name, args)
        └── エラー時: そのまま throw (フォールバックなし)
```

#### callWithDiagnostics() — エラーを投げない診断版

```typescript
type DiagnosticResult<T> =
  | { success: true; result: T }
  | { success: false; error: { type: 'function_error' | 'runtime_error'; message: string } };

// 内部で call() を呼び、エラーは DiagnosticResult.error に格納
async callWithDiagnostics<T>(name: string, ...args: unknown[]): Promise<DiagnosticResult<T>>
```

- エラーを throw せず、常に `DiagnosticResult` を返却する
- デバッグ・テスト時にエラー詳細を取得するために使用する

#### dispose() — リソース解放

`sandboxExecutor.dispose()` を呼び出す。冪等である (複数回呼び出しても安全)。
`disposed` フラグでダブルディスポーズを防止する。

### 6.3 キャッシュ戦略

#### マニフェストキャッシュ (ManifestFetcher)

```
初回 fetch() → GET /manifest → インメモリに保存
以降 fetch() → キャッシュから即座に返却
invalidate() → キャッシュクリア (次回fetchでサーバーアクセス)
```

- TTL はなく、明示的な invalidate でのみクリアされる
- スコープはインスタンス単位である

#### コードキャッシュ (CodeFetcher)

```
fetch(entry) → entry.hash をキーにキャッシュ検索
  キャッシュヒット → 即座に返却
  キャッシュミス → GET entry.codeUrl → ダウンロード → hash でキャッシュ
```

- **ハッシュベースキャッシュ**: URL ではなくコンテンツハッシュをキーに使用する
- 同一コードの関数が複数あっても1回だけダウンロードする
- ハッシュが変わらない限りキャッシュは永続する

### 6.4 SandboxExecutor インターフェース

```typescript
interface SandboxExecutor {
  execute(code: string, args: unknown[]): Promise<unknown>;
  dispose(): void;
}
```

**規約**:
- コードは `function run(...args) { ... }` を定義すること
- executor は `run(...args)` を呼び出して結果を返す
- 実行エラーは `UnzenFunctionError` としてスローする
- `dispose()` は冪等である (複数回呼び出しても安全)

**Phase 1 (MVP)**: `MockSandboxExecutor`
- Node.js `vm` モジュールで実行する
- セキュリティはない (テスト用のみ)
- 最小限のグローバルを提供する (Array, Object, String, Number, Boolean, Math, JSON, Error)
- **同期関数のみサポートする** (Phase 1 制約: async/Promise は未対応)

**Phase 2 (実装済み)**: `WebWorkerSandboxExecutor`
- Web Worker 内で QuickJS Wasm を実行する
- 4層サンドボックスで隔離する: Worker → Wasm → QuickJS → API制限

### 6.x WebWorkerSandboxExecutor の実行ライフサイクル (issue #106)

状態機械は `empty → initializing → ready → empty` を遷移し、どの状態からも `disposed` へ遷移できる。

| 項目 | 方針 |
|------|------|
| 並行実行 | **single-flight**。1つの Worker generation につき実行中 request は1件のみ。超過分は有界 FIFO queue (`maxQueueSize`、既定4) で待機。溢れた request は即時 `RUNTIME_ERROR` で拒否 |
| 実行タイムアウト | 協調 timeout (QuickJS interrupt handler、`timeout`) と hard kill (`timeout × hardKillMultiplier`) の2段階。**hard-kill timer は実行開始時点から計測**するため、queue 待ち時間を実行タイムアウトと誤認しない |
| 初期化タイムアウト | `initTimeoutMs` (既定10000) 以内に `init-result` が返らない場合、init waiter を `RUNTIME_ERROR` で settle し Worker を終了 |
| キャンセル | `execute(code, args, { signal })` で AbortSignal を受け付ける。queued 中は queue から除去して即時 `UnzenCancelledError` (`CANCELLED`) で reject。実行中は worker protocol へ cancel を送信し、`cancelAckTimeoutMs` 内に acknowledgement がなければ generation を強制終了 |
| Generation 管理 | Worker を (再)生成するたびに `generationId` を採番。全 response を protocol version / generation id で検証し、旧 generation の late response・duplicate completion・malformed response を拒否して diagnostics に集計 |
| Generation-fatal 失敗 | hard timeout / worker crash / protocol violation は generation-fatal。実行中 request を即時 settle → Worker 終了 → queue の残りを新 generation で再開 (各 request の AbortSignal を再確認) |
| エラー分類 | `function_error` → `UnzenFunctionError` (fallback なし)、`runtime_error` → `UnzenRuntimeError` (fallback あり)、キャンセル → `UnzenCancelledError` (fallback なし) |

### 6.y UnzenClient の実行ライフサイクル (issue #105)

`execute(request)` / `executeWithDiagnostics(request)` は明示的な request object を受け取る。

```ts
interface UnzenExecutionRequest {
  name: string;
  args: unknown[];
  signal?: AbortSignal;   // manifest fetch → sandbox → server fallback まで伝播
  onEvent?: (event: UnzenExecutionEvent) => void;
}
```

- **イベント**: `accepted` / `manifest-fetch-started|completed` / `code-fetch-started|completed` / `browser-execution-started|failed` / `fallback-started` / `server-execution-started` / `completed` / `cancel-requested` / `cancelled` / `failed`。各 event は `executionId`・monotonic `sequence`・`timestamp` を持ち、`completed` / `cancelled` / `failed` の terminal event は1実行につき正確に1回。
- **キャンセル**: 1つの AbortSignal が manifest/code fetch・sandbox・fallback へ一貫して伝播する。`UnzenCancelledError` (code `CANCELLED`) は **server fallback を開始しない**。dispose() は進行中 execution を cancel して settle させる。
- **診断**: `ExecutionDiagnostics` は browser/server の attempt chain (`attempts`)、`fallbackUsed`、`finalRoute`、`totalDurationMs`、`manifestCache` を保持。browser 失敗→server 成功の経緯を確認できる。
- **エラーコード**: `cancelled` / `manifest_fetch_failed` / `code_fetch_failed` / `browser_runtime_failed` / `function_failed` / `server_fallback_failed` / `client_disposed`。UI 状態は message 解析ではなく code で判定する。
- **互換**: 既存 `call(name, ...args)` / `callWithDiagnostics(name, ...args)` は signal なしの compatibility wrapper として維持。`execution` 本文・args・raw stack は event / diagnostics に含めない。

---

## 7. デモアプリケーション

### 7.1 構成

```
demo/
├── server.ts           Honoサーバー (関数登録 + middleware)
├── public/
│   ├── index.html      インタラクティブデモページ
│   └── demo.js         クライアントサイドスクリプト
└── tests/
    └── integration.test.ts   21件の統合テスト
```

### 7.2 登録されている関数

| 関数名 | コード | 用途 |
|--------|-------|------|
| spamCheck | `(text) => { ... keywords.some(...) }` | スパム検出 |
| add | `(a, b) => a + b` | 加算 |
| multiply | `(a, b) => a * b` | 乗算 |
| doubleArray | `(arr) => arr.map(x => x * 2)` | 配列変換 |
| getUserInfo | `(user) => ({ fullName, isAdult, initials })` | オブジェクト変換 |
| formValidate | `(fields) => { ... }` | フォームバリデーション (email/CC/phone/password) |
| calculatePrice | `(order) => { ... }` | 価格計算 (税/割引/送料) |
| markdownToHtml | `(markdown) => { ... }` | Markdown→HTML変換 (XSSサニタイズ付き) |
| textStats | `(text) => { ... }` | テキスト統計 (FK読解力スコア等) |

### 7.3 起動方法

```bash
cd core/demo
npm install
npm run start    # → http://localhost:3000
```

### 7.4 統合テスト構成

Hono の `app.request()` を使用したHTTPレベルテスト:

| テストスイート | テスト数 | 検証内容 |
|--------------|---------|----------|
| Manifest Endpoint | 3 | 関数リスト、メタデータ |
| Code Endpoint | 4 | コード取得、404、キャッシュヘッダー |
| Fallback (spamCheck) | 5 | スパム検出 正/負ケース |
| Fallback (add) | 4 | 正数/負数/ゼロ/小数 |
| Error Handling | 2 | 404, 400 |
| Full Flow | 1 | manifest → code → execute |
| Static Files | 2 | HTML, JS配信 |

---

## 8. データフロー詳細

### 8.1 関数登録 (サーバー起動時)

```
defineRaw('add', '(a, b) => a + b')
  │
  ├── コードラップ
  │   code = 'function run(...args) { return ((a, b) => a + b)(...args); }'
  │
  ├── バージョン付与
  │   versionCounter++ → version = 1
  │   注意: インメモリカウンタのためサーバー再起動でリセットされる
  │   (Phase 1 制約。Phase 2 ではコンテンツハッシュベースのバージョニングを検討)
  │
  ├── ハッシュ生成
  │   hash = 'sha256:' + crypto.createHash('sha256').update(code).digest('hex')
  │
  └── レジストリ登録
      registry.set('add', { name, runtime:'quickjs', code, version, hash })
```

### 8.2 ブラウザ実行フロー (production モード)

```
1. client.call('add', 1, 2)

2. ManifestFetcher.fetch()
   → [キャッシュミス] GET /unzen/manifest
   → { functions: { add: { runtime:'quickjs', hash:'sha256:...', version:1,
                           codeUrl:'http://localhost:3000/unzen/code/add?v=1' } } }
   → キャッシュに保存

3. manifest.functions['add'] → entry 取得

4. CodeFetcher.fetch(entry)
   → [キャッシュミス] GET /unzen/code/add?v=1
   → 'function run(...args) { return ((a, b) => a + b)(...args); }'
   → entry.hash をキーにキャッシュ

5. SandboxExecutor.execute(code, [1, 2])
   → vm.createContext({ Array, Object, ... })
   → script.runInContext(code)  // run関数を定義
   → context.run(1, 2)         // 実行
   → 3

6. return 3
```

### 8.3 フォールバック実行フロー

```
1. ブラウザ実行が UnzenRuntimeError で失敗

2. FallbackHandler.execute('add', [1, 2])
   → POST /unzen/exec/add
     Body: { "args": [1, 2] }
   → HTTP 4xx + error body: UnzenFunctionError (ユーザーコードバグ, リトライ不可)
   → HTTP 5xx + error body: UnzenNetworkError (サーバー問題, リトライ可)
   → HTTP非200 + body解析不可: UnzenNetworkError
   → HTTP200 + error フィールドあり: UnzenFunctionError
   → HTTP200 + error なし: data.result を返却

3. サーバー側:
   → QuickJSRuntime.execute(code, [1, 2])
     → newContext() + setMemoryLimit(16MB)
     → Object.defineProperty で eval/Function/Proxy/Reflect 無効化
     → evalCode(code) → run関数ロード
     → globalThis.__args__ = [1,2]  (※ undefined → null 変換あり)
     → evalCode('run(...globalThis.__args__)') → 3
     → context.dispose()
   → { "result": 3 }

4. return 3
```

---

## 9. Phase 1 の既知制約

| 制約 | 詳細 | Phase 2 対応 |
|------|------|-------------|
| 同期関数のみ | async/Promise 未対応 | QuickJS の Promise 対応検討 |
| バージョンカウンタ揮発 | サーバー再起動でリセット | コンテンツハッシュベースに移行 |
| JSON引数制約 | `undefined` → `null`, `Date`/`Map`/`Set` 非対応 | 構造化クローン検討 |
| セキュリティ不足 (クライアント) | MockSandboxExecutor はセキュリティなし | WebWorker + QuickJS Wasm |
| WeakRef/FinalizationRegistry | QuickJSバージョン依存 (存在時のみ無効化) | 最小グローバルアプローチ |
| ETag 未対応 | マニフェスト毎回全文取得 | Conditional GET 実装 |

---

## 10. Phase 2 計画

| 項目 | 概要 |
|------|------|
| Web Worker + QuickJS Wasm | 本物のブラウザサンドボックス (4層隔離) |
| ETag/Conditional GET | マニフェストの効率的キャッシュ更新 |
| MoonBit wasm-gc | 高性能計算用ランタイム統合 |
| Service Worker | オフラインキャッシュ対応 |
| ビルドツール統合 | Vite/webpack プラグインでコンパイル時関数抽出 |

---

## 11. テスト一覧

```
Test Files  15 passed (15)
Tests       239 passed (239)
Duration    ~1.3s

packages/shared/tests/types.test.ts            (15 tests)
packages/shared/tests/errors.test.ts           (10 tests)
packages/shared/tests/protocol.test.ts         (13 tests)
packages/server/tests/function-registry.test.ts (10 tests)
packages/server/tests/manifest-builder.test.ts  (6 tests)
packages/server/tests/quickjs-runtime.test.ts   (19 tests)
packages/server/tests/unzen-server.test.ts      (13 tests)
packages/server/tests/http-routes.test.ts       (13 tests)
packages/client/tests/fallback-handler.test.ts   (8 tests)
packages/client/tests/manifest-fetcher.test.ts  (10 tests)
packages/client/tests/code-fetcher.test.ts       (8 tests)
packages/client/tests/quickjs-sandbox.test.ts   (11 tests)
packages/client/tests/unzen-client.test.ts      (15 tests)
demo/tests/integration.test.ts                  (21 tests)
demo/tests/sample-functions.test.ts             (66 tests)
```
