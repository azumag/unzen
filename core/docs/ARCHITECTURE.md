# unzen core Phase 1 MVP アーキテクチャ・実装ドキュメント

**バージョン**: 1.1
**作成日**: 2026-02-07
**テスト**: ユニット・統合は `npm test`、ブラウザE2Eは `npm run e2e -w @unzen/demo`
で通過状態を確認できる（件数はコードベースの進捗に合わせて変化するため固定記載しない）

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
│  ├── ManifestFetcher → GET /manifest (schema 検証 + キャッシュ)     │
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

// HTTP 由来の manifest を検証し、prototype-safe な snapshot にコピー
function normalizeManifestResponse(value: unknown): ManifestResponse | undefined;

// server 側 manifest 生成も definition/base URL を検証し、null-prototype table と
// encoded aggregate 1 MiB 上限を保証
function createManifestResponse(
  functions: Record<string, FunctionDefinition>,
  baseUrl: string,
): ManifestResponse;

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
- server/browser QuickJS の公開 `execute()` 境界は code 16 MiB、serialized args 4 MiB、
  最大128引数を worker / context 作成前に検証する。server timeout は 1〜2,000ms とする。
  引数は iterator を使わない indexed copy 後に JSON 化し、循環値・BigInt・caller mutation と
  過大 payload を QuickJS の外側で遮断する
- QuickJSRuntime の `initialize()` は single-flight とし、`dispose()` は terminal state とする。
  dispose 中に完了した非同期初期化は module を公開せず、runtime を復活させない
- fallback request は UTF-8 JSON 4 MiB、client の response body は manifest 1 MiB、
  function code / MoonBit module 16 MiB、fallback response 16 MiB を上限とする。送信前の
  serialized request と受信時の宣言 `Content-Length` を検証し、stream 実 byte 数も読みながら
  検証して、上限超過時は body を cancel する。server は request 超過を構造化 413 で返す。
  fallback result も一度だけ JSON 化し、過大または JSON 化不能なら構造化 422 を返す
- server 登録境界は raw source の UTF-8 byte 数を16 MiBに制限する。MoonBit file は
  descriptor上でregular fileか確認し、宣言サイズを64 KiB chunkで読み取って末尾を1 byteだけ
  probeするため、読み取り中の肥大化や特殊ファイルでも上限を越えてbufferしない。超過時は
  version 採番・hash・registry 変更前に拒否する。code response は
  captured payload と一致する `Content-Length` を返す。shared definition validator と公開
  `FunctionRegistry.register()` も `FunctionDefinition.code` の UTF-8 byte 数へ同じ上限を適用する
- candidate definition を含む aggregate manifest を登録前に生成し、UTF-8 1 MiB 超なら
  version counter / registry / immutable payload store を変更せず拒否する。manifest response は
  function key を canonical 順に serialize し、同じ body から `Content-Length` と ETag を返す。
  ETag は `codeUrl` / `noFallback` / export / ABI を含む全 field を識別する
- manifest の `If-None-Match` は weak comparison で strong/weak tag、quoted comma を含む
  tag list、`*` を評価する。field 全体を parse できない場合は条件を無視して `200` を返す
- server `baseUrl` は credential / query / fragment のない HTTP(S) absolute URL または
  origin-relative path に構築時正規化する。config field は一度だけ読み、protocol-relative URL と
  schemeなし相対 path を fail fast で拒否する。公開 `ManifestBuilder` も同じ normalizer を使う
- FallbackHandler: HTTP 4xx + error body → `UnzenFunctionError` (リトライ不可)
  HTTP 5xx + error body → `UnzenNetworkError` (リトライ可)
  body解析不可 → `UnzenNetworkError`
  direct call の invalid signal → serialization / HTTP 前に `UnzenFunctionError`

### 4.3 通信プロトコル (protocol.ts)

#### マニフェスト (GET /manifest)

```json
{
  "functions": {
    "spamCheck": {
      "runtime": "quickjs",
      "hash": "sha256:abc123...",
      "version": 1,
      "codeUrl": "http://localhost:3000/unzen/code/spamCheck?v=1&h=sha256%3Aabc123..."
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

- 関数名は英字開始の safe identifier、引数は最大128件
- client は top-level 配列を iterator を使わず index 順に snapshot し、JSON 化できない
  入力を network request 前に `UnzenFunctionError` で拒否する
- server は top-level JSON object と `args` array を型検証し、違反を 400 で返す

成功レスポンス:
```json
{ "result": true }
```

エラーレスポンス:
```json
{ "result": null, "error": "Function execution failed: ..." }
```

- client は plain object の envelope だけを受理する。成功は `result`、失敗は非空の
  string `error` と `result: null` の組み合わせに正規化する
- 現行 JSON transport では successful `undefined` の `result` key が省略されるため、
  空 object は互換表現として `undefined` に復元する。その他の unknown-only object は拒否する
- 2xx の error edge case と 400 / 404 / 422 は `UnzenFunctionError`、redirect、認証系、
  rate limit、5xx、malformed envelope は `UnzenNetworkError` に分類する
- response body の完了後にも AbortSignal を再確認し、cancel 後の遅延 body は採用しない

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
登録名は英字で始まる1〜100文字の英数字・`_`・`-`だけを許可し、空コード、不正な
timeout / fallback metadata、MoonBit の空path・不正なexport / ABI は、ファイル読込や
version 更新より前に拒否する。
`define()` は captured `Function.prototype.toString` で source を取得し、caller-owned
`toString` / `Symbol.toStringTag` を実行せず async・generator を登録前に拒否する。

`FunctionRegistry`は登録時に`FunctionDefinition`をruntime検証し、unknown fieldを落とした
所有スナップショットとして保存する。`get()` / `getAll()`でも定義とネストしたMoonBit ABIを
再コピーするため、呼び出し側による変更がmanifest・code配信・fallback実行へ逆流しない。

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
   g. `SANDBOX_SYNCHRONOUS_EXECUTION`で`run(...globalThis.__args__)`を実行
      → Promise/thenableまたはiterator/generator結果を拒否
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
| WeakRef / FinalizationRegistry禁止 | 存在時undefined化 | `Object.defineProperty(configurable:false)` |
| WebAssembly禁止 | 存在時undefined化 | `Object.defineProperty(configurable:false)` |
| 戻り値契約 | 同期materialized値のみ | shared実行guardでthenable/iteratorを拒否 |
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
 ├── ManifestFetcher     GET /manifest (schema 検証 + インメモリキャッシュ)
 ├── CodeFetcher         GET /code/:name (SHA-256 検証 + ハッシュキャッシュ)
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
│   │   ├── ManifestFetcher.fetch() → schema 検証済み manifest (キャッシュ)
│   │   ├── manifest.functions[name] → エントリ検索
│   │   │   └── 無い場合: throw UnzenFunctionError (フォールバックしない)
│   │   ├── CodeFetcher.fetch(entry) → 生バイト取得・SHA-256 検証・キャッシュ
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
初回 fetch() → GET /manifest → schema 検証 + snapshot → インメモリに保存
以降 fetch() → キャッシュから即座に返却
invalidate() → 進行中 fetch を abort + キャッシュクリア (次回fetchで再取得)
```

- `functions`、安全な関数名、`quickjs | moonbit`、正の safe integer version、
  canonical SHA-256、HTTP(S) / relative `codeUrl`、optional metadata を実行時検証する
- 検証済み関数表は null-prototype record へコピーし、`toString` 等の inherited key を
  未登録関数として扱う。MoonBit ABI も bounded indexed copy で snapshot 化する
- cache hit / concurrent waiter / 304 revalidation / `getEntry()` は entry と nested ABI を
  deep copy し、cache-owned manifest と ETag 用 `lastManifest` の参照を外部へ公開しない
- 304 は対応する `If-None-Match` を送信した request でのみ受理し、validator のない 304 は拒否する
- JSON parse / schema 検証 / abort check がすべて成功した body と ETag だけを同時 commit する
- malformed body、abort 後に遅延完了した body、invalidate 前の in-flight body は保存しない
- TTL はなく、明示的な invalidate でのみクリアされる
- スコープはインスタンス単位である

#### コードキャッシュ (CodeFetcher)

```
fetch(entry) → entry.hash をキーにキャッシュ検索
  キャッシュヒット → 即座に返却
  キャッシュミス → GET entry.codeUrl → 生バイトを SHA-256 検証
                 → UTF-8 decode → hash でキャッシュ
```

- **ハッシュベースキャッシュ**: URL ではなくコンテンツハッシュをキーに使用する
- 同じ hash の concurrent miss は1つの HTTP request に single-flight 化する。各 caller は
  独立して cancel でき、最後の waiter が離れた時だけ共有 request を abort する
- public `fetch()` は QuickJS manifest entry と `AbortSignal` を副作用前に検証し、entry を
  一度だけ snapshot する。応答待機中の caller mutation は URL / hash / cache key を変えない
- `ManifestFetcher.fetch()` も signal を cache hit / HTTP request より前に検証する
- manifest hash は canonical な `sha256:<64 lowercase hex>` だけを受理する
- SHA-256 不一致、invalid UTF-8、Web Crypto 不在時は decode / 実行 / cache 前に
  fail closed とし、不正な payload をキャッシュしない
- 検証は Service Worker に依存せず通常 fetch path で必ず行う。Service Worker は
  CacheStorage への永続化前に同じ生バイト検証を重ねる
- 同一コードの関数が複数あっても1回だけダウンロードする
- settled code は UTF-8 byte weight の LRU でインスタンスごとに既定32MiBまで保持する。
  `CodeFetcher` の `maxCacheBytes` で変更でき、0はsettled cacheを無効にする

#### 永続コードキャッシュ (Unzen Cache Service Worker)

```
GET /code/name?v=N&h=sha256:... → CacheStorage (`unzen-code-v2`)
  cache hit  → version/hashが同一の検証済みResponseを返す
  cache miss → network 200 + immutable + JS/Wasm + SHA-256一致時だけ保存
```

- manifest の `codeUrl` は version と SHA-256 の両方を含む。version counter が
  server restart で再利用されても、異なる payload は同じ cache key にならない
- server は保存済み `{name, version, hash}` と一致する URL だけを immutable とし、
  hash mismatch は `404 no-store`、旧 version-only URL は `no-cache` で扱う
- Service Worker は同一 origin の versioned `/code/` GET だけを intercept し、
  `v` が正の safe integer で canonical SHA-256 を持つ場合だけ扱う。
  manifest・fallback・一般 asset・cross-origin request には介入しない
- integrity 検証用 clone は `Content-Length` と stream 実 byte 数の両方を 16 MiB に制限する。
  超過時は network / verification の両 response branch を cancel し、`502 no-store` で fail closed
- registration options と container の `register` method は一度だけ読み取ってから検証し、
  不正 shape / unreadable getter では Service Worker 登録を開始しない
- activation 時は `unzen-code-` prefix の旧 generation のみ削除する。bounded policy 導入時に
  cache name を `v2` へ更新し、旧 `v1` entry を再利用しない

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
- 関数は同期的にmaterializedな値を返すこと。Promise/thenableとiterator/generator結果は拒否する
- 実行エラーは `UnzenFunctionError` としてスローする
- `dispose()` は冪等である (複数回呼び出しても安全)

**Phase 1 (MVP)**: `MockSandboxExecutor`
- Node.js `vm` モジュールで実行する
- セキュリティはない (テスト用のみ)
- 最小限のグローバルを提供する (Array, Object, String, Number, Boolean, Math, JSON, Error)
- **同期materialized戻り値のみサポートする** (QuickJS executorと同じshared guardを適用)

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
| キャンセル | `execute(code, args, { signal })` で AbortSignal を受け付ける。queued 中は queue から除去して即時 `UnzenCancelledError` (`CANCELLED`) で reject。実行中は worker protocol へ cancel を送信し、`cancelAckTimeoutMs` 内に acknowledgement がなければ generation を強制終了。送信済み cancel に対応しない acknowledgement も protocol violation として generation を破棄 |
| Constructor境界 | QuickJS / MoonBit worker executor とも、空`workerUrl`、非関数`createWorker`、非正・非整数・2,147,483,647ms超のtimer、0未満/非整数のqueue、非有限のmultiplier、timer範囲外になるhard-kill積を同期的に拒否 |
| QuickJS call境界 | per-call option bag / signal、非空code、最大128引数、JSON化可能性をworker生成前に検証する。optionは一度だけ読み、引数はiteratorを呼ばないindexed copy後にJSON round-tripし、queue/init待機中のcaller mutationとworker側serialization失敗を防ぐ。Mock executorも同じ契約 |
| Generation 管理 | Worker を (再)生成するたびに `generationId` を採番。worker は全requestのversion / generation / type別field / payload上限をstate変更・runtime初期化・compile前に検証し、mainは全responseのversion / generation / success-error envelopeを検証する。旧generationのlate response・duplicate completion・malformed responseを拒否してdiagnosticsに集計 |
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

- **constructor 境界**: option bag、非空 `endpoint`、3種類の `mode`、選択した worker URL / MoonBit
  compile option、custom executor の callable surface を component 生成前に検証する。選択肢は
  一度だけ読み、custom executor の method reference は元 instance に bind した snapshot として
  保持する。endpoint は 2,048 byte 以下、credential / query / fragment のない HTTP(S) absolute
  URL または origin-relative path に限定して正規化する。protocol-relative URL と scheme なし
  relative path は拒否し、public `FallbackHandler` / `ManifestFetcher` にも同じ境界を適用する。
- **request 境界**: `name` は safe identifier、`args` は最大128件の配列とし、manifest
  fetch より前に request field を一度だけ読む。top-level の引数 slot は iterator を
  呼ばない bounded indexed copy で浅く snapshot する。`signal` / `onEvent` も型検証して
  参照を固定し、違反は副作用前に `UnzenFunctionError` / `function_failed` として返す。
- **イベント**: `accepted` / `manifest-fetch-started|completed` / `code-fetch-started|completed` / `sandbox-initializing`（サンドボックスの遅延初期化時のみ）/ `browser-execution-started|failed` / `fallback-started` / `server-execution-started` / `completed` / `cancel-requested` / `cancelled` / `failed`。各 event は `executionId`・monotonic `sequence`・`timestamp` を持ち、terminal event は1実行につき正確に1回。`cancel-requested` 以降は新しい phase event を emit しない。
- **キャンセル**: 1つの AbortSignal が manifest/code fetch・sandbox・fallback へ一貫して伝播する。`UnzenCancelledError` (code `CANCELLED`) は **server fallback を開始しない**。dispose() は進行中 execution を cancel して settle させる。
- **診断**: `ExecutionDiagnostics` は browser/server の attempt chain (`attempts`)、`fallbackUsed`、`finalRoute`、`totalDurationMs`、`manifestCache` を保持。browser 失敗→server 成功の経緯を確認できる。
- **エラーコード**: `cancelled` / `manifest_fetch_failed` / `code_fetch_failed` / `browser_runtime_failed` / `deadline_exceeded`（タイムアウト）/ `function_failed` / `server_fallback_failed` / `server_network_failed`（fallback のネットワーク失敗）/ `client_disposed`。UI 状態は message 解析ではなく code で判定する。
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
    └── integration.test.ts   統合テスト
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

| テストスイート | 検証内容 |
|--------------|----------|
| Manifest Endpoint | 関数リスト、メタデータ |
| Code Endpoint | コード取得、404、キャッシュヘッダー |
| Fallback (spamCheck) | スパム検出 正/負ケース |
| Fallback (add) | 正数/負数/ゼロ/小数 |
| Error Handling | 404, 400 |
| Full Flow | manifest → code → execute |
| Static Files | HTML, JS配信 |

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
                           codeUrl:'http://localhost:3000/unzen/code/add?v=1&h=sha256%3A...' } } }
   → schema 検証 + prototype-safe snapshot 後に ETag と同時保存

3. manifest.functions['add'] → entry 取得

4. CodeFetcher.fetch(entry)
   → [キャッシュミス] GET /unzen/code/add?v=1&h=sha256%3A...
   → response の生バイトを entry.hash と SHA-256 照合
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
     → shared guard経由で run(...globalThis.__args__) → 3
     → context.dispose()
   → { "result": 3 }

4. return 3
```

---

## 9. Phase 1 の既知制約

| 制約 | 詳細 | Phase 2 対応 |
|------|------|-------------|
| 同期戻り値のみ | async/Promise/generatorとthenable/iterator結果を拒否 | 全executorへ契約適用済み |
| バージョンカウンタ揮発 | サーバー再起動でリセット | code URL に version + SHA-256 を含めて解決済み |
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
| MoonBit wasm-gc | 高性能計算用ランタイム統合 (**実装済み**: `MoonBitSandboxExecutor` + `defineMoonbit`) |
| Service Worker | versioned code/Wasm の hash 検証付き CacheStorage (**実装済み**) |
| ビルドツール統合 | Vite plugin / webpack loaderによるASTベースのコンパイル時関数抽出 (**実装済み**) |
| TypeScript型生成 | 抽出signatureからVite build assetとtyped `UnzenClient` schemaを生成 (**実装済み**) |

### コンパイル時関数抽出 (Phase 3)

```
TypeScript source
  → TypeScript ASTで @unzen/server import / const instance / define callを照合
  → TypeScript symbol/scopeで外部capture・入力/global代入・禁止/非決定的APIを検査
  → 型引数 / parameter / return annotationを抽出（未注釈はunknown）
  → inline関数だけをES2018 JavaScriptへtranspile
  → [dependencyBundling指定時] 参照runtime importだけをesbuildで自己完結化
     → entry / 推移依存をallowlist検証 → 100KiB既定上限 → bundle後の禁止API検査
     → metafileから依存fileを収集し、抽出関数だけが使うimport bindingをhost sourceから除去
  → MagicStringで defineRaw(name, code, options) に局所置換 + source map
  → Vite addWatchFile / webpack addDependencyへ依存fileを登録
  → Vite pre-transform / webpack loaderへ同じ結果を返す（依存bundle時だけ非同期）
  → Vite build時は名前順のunzen-functions.d.ts assetをemit
```

- 対象をトップレベルのinline同期関数に限定し、動的名・外部関数・入れ子を含む
  async/generator構文とglobal `Promise`はbuild時にfile/line/column付きで拒否する
- 関数内のlocal bindingと外部captureをsymbolで区別するため、コメント・文字列・local
  shadowingは誤検知せず、標準モードのruntime import、`this`/`super`、禁止global、dynamic import、
  `import.meta`、入力/globalへの代入、`Math.random()`、`Date.now()`、
  引数なし`Date`生成を位置付きerrorにする。QuickJS初期化が無効化するglobal一覧は
  `SANDBOX_DISABLED_GLOBALS`を純粋性検査とbundle後検査でも共有する。local working stateへの
  代入は許可する
- unrelated `.define()`、nested call、`node_modules`は変換しない
- webpack loaderはESM/CJS両方で配布し、raw TypeScriptを読むためloader chainの
  最初（`use`配列の右端）に置く
- AST変換はクロージャ値を埋め込まない。runtime importは標準では拒否し、Vite plugin /
  webpack loaderで`dependencyBundling.allowedModules`を明示した場合だけ、関数が実際に
  参照するimport bindingを`bundle()`へ渡す。type-only importと同じmoduleの無関係な
  runtime importは抽出entryに含めない。抽出関数だけが使うruntime bindingはhost sourceから
  除去し、host codeでも使うbindingは保持する。esbuildが読んだ依存fileはVite / webpackの
  watch graphへ登録する
- `bundle()`はin-memory entryを`resolveDir`（省略時`process.cwd()`）基準で解決する。
  entryの静的import / re-exportはASTで収集し、dynamic importはesbuild変換前に拒否する。
  bare packageの推移依存も`onResolve`で個別にallowlist検証し、依存内のdynamic importも
  lower前に拒否する。出力は`defineRaw()`へ直接登録できる自己完結した`function run`
- `bundle()`は最終`function run`をUTF-8 byte数で計測し、既定100KiBを超えるpayloadを
  禁止APIのAST scanとsandbox投入より前に拒否する。`maxBundleSize`で明示的に調整できる
- Viteの`declarationFile`指定時は、重複名を位置付きerrorにし、生成された
  `UnzenFunctions`を`UnzenClient<UnzenFunctions>`へ渡してcall境界を型付けする。
  webpack loaderはmodule単位の変換だけを行い、宣言集約は行わない

### MoonBit wasm-gc 統合 (Phase 3)

- `UnzenServer.defineMoonbit(name, wasmPath, { exportName, abi })` は wasm モジュールを
  登録し、`/code/:name` が `application/wasm` でバイト配信する。
  マニフェストエントリは `runtime: 'moonbit'`、`exportName`、指定時は
  `moonbitAbi` を持つ。ABI は export ごとの `params` / `result` を
  `scalar` / `i32[]` / `f64[]` で表す。
  登録時に検証した正確なバイトを `{name, version, hash}` identity で保持し、
  `?v=N&h=HASH` の immutable URL は常にその version のバイトを返す（同名再登録で旧 URL の
  内容が変わらない）。registry 上で quickjs に上書きされても、既に公開済みの
  versioned URL を守るため旧バイトは保持される。
- `MoonBitSandboxExecutor` (client) は wasm をフェッチし、生バイトを manifest hash と
  SHA-256 照合してから `WebAssembly.compile` でキャッシュする。`spectest` 等の MoonBit
  ランタイム import のみでインスタンス化して指定 export を呼ぶ。`UnzenClient` は
  マニフェストの `runtime` で QuickJS パスと MoonBit パスを振り分ける。compiled module
  自体は再利用するが、`prepare()` が返す wrapper は毎回 caller-owned copy とし、
  cache-owned `{ url, module }` を外部 mutation へ公開しない。settled module は LRU で
  既定4 identityまで保持し、`maxCachedModules: 0` ならretentionだけを無効化する。
- `MoonBitWorkerSandboxExecutor` (client) は `moonbitWorkerUrl` 指定時に使われ、
  main thread で同じ生バイト検証を終えてから専用 Web Worker へ渡して wasm を
  実行する（QuickJS パスと同じ Layer 1 の分離）。
  単一実行のみ・有界キュー・init timeout・hard-kill timeout（Worker terminate）・
  generation 管理・キャンセル（終了）を備える。worker バンドルは
  `moonbit-worker.js`（tsup エントリ）として配信する。client/worker bundle は同じ
  build/version から同時配信し、protocol v5 mismatch は fail closed で拒否する。
  URL execution の compiled module cache key は URL と expected SHA-256 の組で作り、同じ
  URL から更新された検証済み bytes が旧 module を再利用しないようにする。main thread の
  verified byte cache と worker 内 compile cache も同じ `maxCachedModules` の LRU 上限に従う。
- Worker 内の MoonBit export は同期・中断不可のため、タイムアウト/キャンセルは
  `Worker.terminate()` で強制する。ABI 省略時は number / boolean / bigint /
  string のスカラーのみ、ABI 指定時は `i32[]` / `f64[]` も対応する。
  オブジェクトは非対応。String は JS String Builtins 経由。inline module は private copy 前に
  16 MiB、scalar string 引数は1実行の合計、scalar string 戻り値はそれぞれ UTF-8 で
  4 MiB を上限として検証する。
- サーバーフォールバックは非対応 (`/exec/:name` は 501)。ブラウザ実行のみ。

### MoonBit の String / Array interop (2026-08-11 実測)

`moonbit-poc/interop` パッケージ（`echo` / `join_words` / `sum_array` /
`string_len` / `make_string` / `make_array` / `reverse_array`）を
Chromium 145 と Firefox 146 で probe した結果:

- **String は対応**: MoonBit 側の `link.wasm-gc` に
  `use-js-builtin-string: true` + `imported-string-constants: "_"` を指定し、
  クライアント側は `await WebAssembly.compile(bytes, { builtins: ['js-string'],
  importedStringConstants: '_' })` でコンパイルする。compile options が
  `wasm:js-string` builtins と `_` の文字列定数を解決するため、import 側は
  `spectest.print_char` と `console.log` だけでよい（手動で `_` import を
  組み立てる方式は `"__proto__"` 等で Object.prototype を踏むため使わない）。
  `string_len("hello") = 5` / `make_string() = "hello"` / `echo` 往復 /
  `join_words("foo","bar") = "foobar"` に加え、`"__proto__"` / 空文字 /
  Unicode リテラルの往復も両ブラウザで確認した。compile / instantiate は
  非同期 API（`WebAssembly.compile` / `WebAssembly.instantiate`）を使い、
  メインスレッドを長時間ブロックしない。`scalar` ABI はスカラーの種類までは
  固定しない。数値 export へ string を渡すと WebAssembly の暗黙変換で
  数値化される（`fibonacci("10") → 55`）。
  **ブラウザ要件**: String interop は JS String Builtins が別途必要。
  Chromium 145 / Firefox 146 で動作確認済み。Safari は wasm-gc が 18.2+、
  JS String Builtins が 26.2+ で対応となるため、18.2–26.1 では String
  引数・戻り値は使えない（本変更では Safari/WebKit 未検証。compile
  options が効かない場合、文字列定数 / `wasm:js-string` import が解決されず
  低レベルな import エラーになる）。
  executor の既定値は `importedStringConstants: '_'` だが、
  `MoonBitSandboxOptions.importedStringConstants`、
  `MoonBitWorkerSandboxOptions.importedStringConstants`、または
  `UnzenClientOptions.moonbitImportedStringConstants` で変更できる。値は MoonBit
  側の `imported-string-constants` と一致させる。`null` はこの compile option
  を省略する（文字列定数を import しない module 用）。選択した namespace は
  文字列定数用に予約されるため、同 namespace の function import 等とは
  併用できない。Worker は namespace と compile cache 上限を init protocol v5 で受け取り、
  generation 内の全 compile に同じ値を使う。
- **raw wasm の Array は opaque handle**: plain JS 配列は wasm 境界で
  `type incompatibility when transforming from/to JS` となり渡せない。
  `make_array()` の戻り値は opaque な wasm-gc 配列 handle で `.length` や
  添字アクセスはできないが、`sum_array(opaque) = 6` / `reverse_array(opaque)`
  のように別の MoonBit export への再入力（handle round-trip）は動く。
- **unzen は数値配列を明示 ABI でコピー**: `abi.params` / `abi.result` に
  `i32[]` または `f64[]` を指定すると、executor は次の標準 export で
  plain JS 配列と opaque wasm-gc 配列を相互コピーする:
  `unzen_array_i32_new/set/length/get` と
  `unzen_array_f64_new/set/length/get`。正確な MoonBit 契約は次のとおり
  （[reference implementation](../moonbit-poc/interop/main.mbt)）:

  ```moonbit
  unzen_array_i32_new(length : Int) -> Array[Int]
  unzen_array_i32_set(arr : Array[Int], index : Int, value : Int) -> Unit
  unzen_array_i32_length(arr : Array[Int]) -> Int
  unzen_array_i32_get(arr : Array[Int], index : Int) -> Int
  unzen_array_f64_new(length : Int) -> Array[Double]
  unzen_array_f64_set(arr : Array[Double], index : Int, value : Double) -> Unit
  unzen_array_f64_length(arr : Array[Double]) -> Int
  unzen_array_f64_get(arr : Array[Double], index : Int) -> Double
  ```

  必要な bridge が欠ける場合は
  `UnzenRuntimeError` で fail closed する。`i32[]` は符号付き32 bit整数、
  `f64[]` は JS number のみ許容する。入力は1実行の全配列合計10万要素、
  戻り値は10万要素、引数数は128、scalar string 引数の合計と戻り値はそれぞれ
  UTF-8 で 4 MiB を上限とし、コピー前に型とサイズを検証する。
  引数、ABI、`signal`、export 名、expected hash は待機/初期化前に一度だけ
  読み取ってスナップショットする。worker に直接渡す inline `ArrayBuffer` も
  16 MiB 以下であることを先に検証してから同時点でコピーし、呼び出し後の caller mutation を
  実行中に反映させない。
  空 module URL / 不正 option / 非 `ArrayBuffer` は fetch・worker 生成前に拒否する。
  direct `prepare()` の signal も副作用前に検証し、response body の読み取り失敗は
  stable な network error、内部 abort は runtime error に分類する。
  ABI 省略時の配列拒否は維持する。

### MoonBit Worker 強制終了の検証 (2026-08-11)

`moonbit-poc/hang` パッケージ（`hang_forever` / `bounded_hang`）を実ブラウザで
実行し、以下を確認した:

- `hang_forever` は hard timeout で `DEADLINE_EXCEEDED`、cancel で `CANCELLED`
  となり、いずれも `Worker.terminate()` で強制終了される
- terminate 後は新 generation で再初期化され、後続実行が成功する
- hang 実行中もメインスレッドは応答し続ける（50ms interval の tick が
  実行区間中も正数で継続することを E2E で検証）
- Chromium 145 (Playwright) / Firefox 146 の両方で同一動作（Firefox は wasm 実行が遅く、
  テストの timeout は 800ms budget / 1200ms hard kill に設定）

---

## 11. テスト一覧

現在のテスト件数はコードベースの進捗に合わせて常に変化するため、固定値では
記載しない。確認方法:

```bash
cd core
npm test                        # ユニット・統合 (vitest)
npm run e2e -w @unzen/demo      # ブラウザE2E (Playwright, desktop + mobile)
```
