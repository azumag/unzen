# unzen core

サーバーサイドの計算関数をブラウザ側に委任するフレームワーク。
QuickJS (Wasm) または MoonBit (Wasm) サンドボックスで安全に実行する。

> **ステータス**: Phase 3 完了。モジュールバンドラー、Vite/webpackの
> コンパイル時関数抽出、許可npm依存の関数単位bundle、型定義生成、
> symbol/scopeベースの純粋性・禁止API検査
> (`@unzen/bundler`) が稼働中。
> ユニット・統合テストは `npm test`、ブラウザE2Eは `npm run e2e -w @unzen/demo` で通過状態を確認できる。

## コンセプト

**訪問者が必要とする機能を、訪問者自身のブラウザで実行する。**
サーバーは関数を定義するのみでよい。

1. サーバーで関数を定義
2. 訪問者のブラウザ内の QuickJS Wasm サンドボックスで実行
3. ブラウザで実行できない場合はサーバーにフォールバック

## 基本的な使い方

```bash
npm install @unzen/server @unzen/client
```

```typescript
// server.ts - サーバー側
import { UnzenServer } from '@unzen/server';
import { Hono } from 'hono';

const app = new Hono();
const unzen = new UnzenServer({ baseUrl: 'http://localhost:3000/unzen' });

// JSON Schema バリデーション — ブラウザで実行される
unzen.defineRaw('jsonSchemaValidate', `function run(schema, data) {
  function validate(schema, data, path) {
    var errors = [];
    // ... 再帰的スキーマ検証 (型、必須、パターン、ネスト対応)
    return errors;
  }
  var errors = validate(schema, data, '$');
  return { valid: errors.length === 0, errors: errors };
}`, { timeout: 500 });

await unzen.initialize();
app.route('/unzen', unzen.middleware());
```

### Vite / webpack でのコンパイル時抽出

`Function.prototype.toString()` を本番bundle後に呼ぶ代わりに、ビルド時にinline関数を
JavaScript文字列へ変換できる。TypeScriptの引数・戻り値型は抽出時に除去される。

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { unzenVitePlugin } from '@unzen/bundler';

export default defineConfig({
  plugins: [unzenVitePlugin({
    declarationFile: 'unzen-functions.d.ts',
    // npm importをinline関数で使う場合だけ明示する
    // dependencyBundling: {
    //   allowedModules: ['lodash', 'lodash/*'],
    //   maxBundleSize: 100 * 1024,
    // },
  })],
});
```

```typescript
import { UnzenServer } from '@unzen/server';

const unzen = new UnzenServer({ baseUrl: '/unzen' });
unzen.define('sum', (a: number, b: number): number => a + b);
// build output: unzen.defineRaw("sum", "(a, b) => a + b")
```

`declarationFile`はViteの`outDir`へ`UnzenFunctions`と`TypedUnzenClient`を生成する。
生成型を使うと`client.call('sum', 1, 2)`の関数名・引数・戻り値を検査できる。
抽出対象の関数はTypeScriptのsymbol/scope解析も通り、クロージャ・禁止global・
入力/globalへの代入・`Math.random()`や現在時刻への依存をsource位置付きbuild errorで
拒否する。async/generator構文とglobal `Promise`も、入れ子や依存bundle内を含めて拒否する。
runtime importは標準では拒否し、`dependencyBundling`を明示した場合だけ
allowlist検証とbundle後の禁止API検査を経て自己完結コードへ変換する。
依存bundleは最終コードをUTF-8で計測し、既定100KiBを超える場合はbuild errorになる。
抽出関数だけが使うruntime import bindingはhost bundleから除去し、host codeでも使う
bindingは保持する。実際に読んだ依存fileはVite / webpackのwatch graphへ登録される。
webpack loader設定、生成型の利用例、対象構文の制約は
[モジュールバンドラーガイド](docs/bundler.md)を参照。

JavaScript関数の実行契約は同期かつmaterializedな戻り値に限定される。`define()`は
async/generator関数を登録時に拒否し、QuickJS（browser/server）とMock executorは
Promise/thenableまたはiterator/generator結果を同じ契約エラーとして拒否する。
登録名は英字で始まる1〜100文字の英数字・`_`・`-`に限定され、`defineRaw()`は空の
コードを拒否する。先頭が正確な `function run(...)` 宣言の場合だけそのまま保持し、
`function runner(...)` を含む他の関数式は outer `run` で包む。公開されている
`FunctionRegistry`を直接使う場合も、定義全体を
検証してABI配列を含むスナップショットを保持し、`get()` / `getAll()`は独立したコピーを返す。
shared `createManifestResponse()` の直接利用も、base URL・record key と definition name・
全 definition を検証し、null-prototype の関数表を返す。encoded aggregate は生成途中から
1 MiB に制限され、advanced API でも client が拒否する manifest を生成しない。

```typescript
// client.ts - ブラウザ側
import { UnzenClient } from '@unzen/client';

const client = new UnzenClient({
  endpoint: 'http://localhost:3000/unzen',
  mode: 'production',
  workerUrl: '/worker.js',
});

// スキーマ検証がブラウザ内で完了。サーバーへのリクエスト不要
const result = await client.call('jsonSchemaValidate', userSchema, requestBody);
if (!result.valid) {
  showErrors(result.errors);
}
```

### 実行ライフサイクル・キャンセル・診断 (issue #105)

`executeWithDiagnostics()` は AbortSignal によるキャンセル、実行イベント、失敗経緯
(attempt chain) を返す。キャンセルは常に `cancelled` で終わり、サーバーへの
フォールバックを開始しない。

```typescript
const controller = new AbortController();
const result = await client.executeWithDiagnostics({
  name: 'jsonSchemaValidate',
  args: [userSchema, requestBody],
  signal: controller.signal,
  onEvent: (e) => {
    // accepted / manifest-fetch-* / code-fetch-* / sandbox-initializing /
    // browser-execution-* / fallback-started / server-execution-started /
    // completed / cancel-requested / cancelled / failed
    updateUi(e.type);
  },
});

if (!result.success && result.error.code === 'cancelled') {
  // ユーザーがキャンセルした — フォールバックは走っていない
}
```

エラーは安定したコード（`function_failed` / `browser_runtime_failed` /
`deadline_exceeded` / `server_fallback_failed` / `server_network_failed` /
`cancelled` など）で分類され、UI はメッセージ文字列ではなくコードで状態を判定する。

公開 `execute` 境界は安全な関数名と最大128引数だけを受け付け、非同期処理の前に
request field を一度だけ読み、top-level の引数 slot を iterator を使わず index 順に
浅く snapshot する。不正な request は fetch / sandbox 実行前に `UnzenFunctionError`
（diagnostics は `function_failed`）で拒否する。

fallback transport はその snapshot を JSON 化してから送信する。JSON 化できない入力は request 前に
`UnzenFunctionError`、不正な response envelope、redirect、rate limit、5xx は
`UnzenNetworkError` となる。direct `FallbackHandler.execute()` は signal を serialization
より前に検証し、不正値を副作用前に `UnzenFunctionError` で拒否する。body 読み取り中の
cancel は遅延 response を採用しない。

## サンプル関数

### `jsonSchemaValidate` — JSON Schema バリデーション

API リクエストの検証をブラウザで実行する。不正なリクエストがサーバーに到達する前にブロックできる。
ネストしたオブジェクトや配列も再帰的に検証し、エラーパス付きで結果を返す。

```js
const schema = {
  type: 'object',
  required: ['name', 'email'],
  properties: {
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', pattern: '^[^@]+@[^@]+$' },
    address: {
      type: 'object',
      properties: {
        zip: { type: 'string', pattern: '^\\d{5}$' },
      },
    },
  },
};

await client.call('jsonSchemaValidate', schema, formData);
// → { valid: true, errors: [] }
// → { valid: false, errors: ['$.email: string does not match pattern ...'] }
```

### `sortData` — マルチキーデータソート

ダッシュボードテーブルのソートをネットワーク往復なしで実行する。

```js
const sorted = await client.call('sortData', tableData, [
  { key: 'department', order: 'asc' },
  { key: 'salary', order: 'desc' },
]);
// → 部門昇順 → 給与降順でソートされた配列
```

### `levenshteinDistance` — テキスト類似度

O(n*m) の編集距離を計算する。ファジー検索や重複検出をブラウザ内で実行できる。

```js
await client.call('levenshteinDistance', 'kitten', 'sitting');
// → { distance: 3, similarity: 0.57 }
```

### その他のサンプル

- **`formValidate`** — メール・クレジットカード(Luhn)・電話番号・パスワードの複合検証
- **`calculatePrice`** — 税金・割引・送料の計算をブラウザ内で実行
- **`markdownToHtml`** — Markdown→HTML 変換（XSS 防止付き）
- **`textStats`** — 単語数・可読性スコア（Flesch-Kincaid）
- **`hashPassword`** — PBKDF2-HMAC-SHA256 パスワードハッシュ（平文をサーバーへ送らない）

詳細は [サンプル関数リファレンス](docs/sample-functions.md) を参照。

## Fetch 専用サーバコンテナ構成

外部 API の fetch だけをサーバコンテナに残し、正規化、検索、並び替え、集計、
表示用 view model 生成を Unzen のブラウザ sandbox に任せるサイト構成を取れる。
この場合、サーバは secret 境界、cache、rate limit、Unzen manifest/code/worker 配信を担当し、
ページ固有の内部計算は `browser-only` mode の Unzen function で実行する。

責務分離と Next.js App Router での最小構成は
[Fetch 専用サーバコンテナ + Unzen サイト構成](docs/fetch-only-container-site.md) を参照。

検索エンジン、SNS preview、リンク保存サービスなど JavaScript / Web Worker 実行を
前提にできない取得者には、request-time に Unzen をサーバ実行へ戻さず、
公開可能な canonical snapshot と structured data を返す。
詳しくは [クローラーから取得できる Unzen ページ設計](docs/crawler-accessible-unzen-pages.md) を参照。

広告表示や広告計測に参加したくない訪問者には、広告 SDK / 計測の opt-out と
Unzen browser sandbox での計算参加を別の状態として扱う。
詳しくは [広告オプトアウトを選べる Unzen ページ設計](docs/ad-opt-out-participation.md) を参照。

## なぜ unzen？

- **レスポンス向上**: ネットワーク往復なしで即座に結果を返す
- **サーバー負荷軽減**: バリデーションやデータ変換をブラウザで処理し、API呼び出しを減らす
- **プライバシー**: ユーザーデータがサーバーに送信されずにブラウザ内で完結する
- **自動フォールバック**: Wasm未対応ブラウザでも同じ関数がサーバーで実行される
- **セキュリティ**: 4層隔離モデルにより、サードパーティコードをページのメインスレッド・DOM・ネットワークから分離する。これはブラウザ内の隔離境界の保証であり、サーバー側のトラスト境界や認証の代替ではない

## タイムアウト階層

| Tier | Timeout | 用途 |
|------|---------|------|
| default | 50ms | バリデーション、フィルタリング、軽量計算 |
| medium | 500ms | スキーマ検証、データソート、テキスト解析 |
| heavy | 2,000ms | 大規模データ処理、暗号ハッシュ |

```typescript
unzen.defineRaw('lightFunc', code);                    // 50ms (default)
unzen.defineRaw('mediumFunc', code, { timeout: 500 }); // 500ms
unzen.defineRaw('heavyFunc', code, { timeout: 2000 }); // 2,000ms
```

advanced API の `QuickJSRuntime.execute()` と browser QuickJS executor も code を 16 MiB、
serialized args を 4 MiB、引数を最大128件に制限する。server runtime の timeout は
1〜2,000ms とし、非空 code と引数は worker / QuickJS context 作成前に indexed copy と
JSON serialization を完了するため、循環値・BigInt・過大 payload は実行前に拒否される。
`initialize()` は同時呼び出しを single-flight 化し、`dispose()` は terminal なので、破棄後は
新しい `QuickJSRuntime` instance を生成する。

fallback request は UTF-8 JSON 4 MiB、client が受信する untrusted body は manifest 1 MiB、
function code / MoonBit module 16 MiB、fallback response 16 MiB を上限とする。client は送信前に
request を拒否し、server/client の受信側は `Content-Length` だけに依存せず stream の実 byte 数を
計測する。chunked body も上限を越えた時点で cancel し、JSON parse・cache・compile 前に拒否する。
server も fallback result を一度だけ JSON 化して response の 16 MiB 上限と正確な
`Content-Length` を適用し、過大または JSON 化不能な result は構造化 `422` で返す。
server は 16 MiB を超える raw source / MoonBit file を version 採番前に登録拒否し、
`/code/:name` は検証済み payload の正確な `Content-Length` を返す。
公開 `FunctionRegistry.register()` と shared definition validator も `code` の UTF-8 byte 数へ
同じ上限を適用し、advanced API から過大な definition を保持できない。
候補登録後の manifest が 1 MiB を超える場合も registry を変更せず拒否し、`/manifest` は
一度だけ serialize した body と一致する `Content-Length` / ETag を返す。
manifest function key は canonical 順に並び、ETag は code identity だけでなく `codeUrl`、
`noFallback`、export / ABI を含む serialized body 全体の SHA-256 から生成する。
`If-None-Match` は weak comparison で strong/weak tag、tag list、`*` を評価し、
不正文法の field は無視して通常の `200` manifest response を返す。
server `baseUrl` は credential・query・fragment のない absolute HTTP(S) URL または
origin-relative path（`/unzen`、root `/`）だけを受け付ける。前後空白と末尾 slash は
構築時に正規化し、不正設定は最初の manifest fetch まで遅延させず同期的に拒否する。

## 4層隔離モデル

ブラウザ側の関数実行は4層のセキュリティ隔離で保護される:

```
Browser Main Thread                  Web Worker Thread
┌─────────────────────┐             ┌──────────────────────────┐
│ UnzenClient         │  postMsg    │ Layer 1: Web Worker      │
│  └─ WebWorkerSandbox├────────────►│  └─ Layer 2: Wasm sandbox│
│     Executor        │◄────────────┤     └─ Layer 3: QuickJS  │
│     (timeout guard) │  postMsg    │        └─ Layer 4: API制限│
└─────────────────────┘             └──────────────────────────┘
```

| 層 | 隔離内容 |
|---|---|
| Layer 1: Web Worker | 別スレッド、DOMアクセス不可 |
| Layer 2: Wasm sandbox | メモリ隔離（ホストからアクセス不可） |
| Layer 3: QuickJS | 独立JSエンジン（V8とは別） |
| Layer 4: API制限 | eval/Function/Proxy/Reflect/WeakRef/FinalizationRegistry/WebAssembly無効化、プロトタイプ凍結 |

> **MoonBit の隔離について**: `moonbitWorkerUrl` を指定すると MoonBit 関数は
> 専用 Web Worker（`MoonBitWorkerSandboxExecutor`）で実行され、CPU 負荷の高い
> export でもページのメインスレッドをブロックしない。wasm のメモリ分離・
> import 制限（MoonBit runtime import のみ）・ネットワーク/DOM 非アクセスに
> 加えて、タイムアウト/キャンセルは Worker 終了で強制できる。Worker 内の
> export 自体は同期・中断不可（終了は Worker の terminate のみ）。指定しない
> 場合はメインスレッド実行の `MoonBitSandboxExecutor` が使われる（デモ用途）。

## セキュリティ

関数はサンドボックス内で実行される:
- **外部接続禁止**: fetch, WebSocket, XHR 等は一切使えない
- **DOM アクセス不可**: QuickJS は Web Worker 内、MoonBit は `moonbitWorkerUrl`
  指定時に専用 Web Worker 内で実行する（未指定の MoonBit はメインスレッド実行）
- **リソース制限**: QuickJS はメモリ16MB、実行時間はタイムアウト（協調 + 強制停止）。
  MoonBit (Worker) はタイムアウト/キャンセルを `Worker.terminate()` で強制し、module payload は
  16 MiB、scalar string 引数の合計と scalar string 戻り値は UTF-8 で 4 MiB に制限する。
  wasm-gc heap 自体の明示的なメモリ上限はなく、ブラウザが管理する
- **純粋計算のみ**: 入力→計算→出力のみで、副作用はない
- **プロトタイプ汚染防止**: Object/Array/String等の全ビルトインプロトタイプを凍結する
- **コンストラクタチェーン切断**: Function/AsyncFunction/GeneratorFunction/AsyncGeneratorFunction全4種を切断する

## 2つのランタイム

| | QuickJS (JS) | MoonBit (Wasm) |
|---|---|---|
| 言語 | JavaScript | MoonBit |
| 実行方式 | Wasm上でJSを解釈実行 | wasm-gc にネイティブコンパイル |
| サイズ | ~150KB (gzip) + 関数コード | 関数ごとに数百B〜数十KB |
| 性能 | 短時間関数に十分 (50ms以内) | Rustに近い高速実行 |
| ブラウザ | ほぼ全ブラウザ | wasm-gc対応 (Chrome 119+, Firefox 120+, Safari 18.2+; String は Safari 26.2+ 未検証) |
| 用途 | 手軽にJS関数を委任 | 性能が重要な計算処理 |
| 実装状況 | **Phase 2 完了** | **Phase 3 クライアント統合済み** (`MoonBitSandboxExecutor` / `MoonBitWorkerSandboxExecutor`) |

MoonBit 関数は `UnzenServer.defineMoonbit(name, wasmPath, { exportName, abi })` で
登録し、マニフェストは `runtime: 'moonbit'` と wasm の配信 URL、
指定時は `moonbitAbi` を公開する。
クライアントは `moonbitWorkerUrl` 指定時に `MoonBitWorkerSandboxExecutor`（専用
Web Worker、メインスレッド非ブロック・terminate で強制停止）、未指定時は
`MoonBitSandboxExecutor`（メインスレッド、デモ用途）が wasm をフェッチ・
インスタンス化し、指定の export（既定 `run`）を呼び出す。
main-thread の `prepare()` は immutable な compiled module を再利用する一方、
呼び出し元には毎回新しい `{ url, module }` wrapper を返し、cache-owned object を公開しない。
実行はブラウザ限定で、サーバーフォールバックは行わない（QuickJS ランタイムでは
wasm を実行できない）。ABI 省略時は number / boolean / bigint / string の
スカラー入出力のみ対応。String は JS String Builtins 経由
（`use-js-builtin-string`）。`abi.params` / `abi.result` で `i32[]` または
`f64[]` を明示すると、モジュールが公開する標準 `unzen_array_*`
bridge を使って JS 数値配列を wasm-gc 配列と相互コピーする。入力配列は
1呼び出し合計10万要素、戻り値配列は10万要素、引数数は128まで。scalar string は
引数の合計と戻り値をそれぞれ UTF-8 で 4 MiB、inline module は 16 MiB までとし、
inline module は caller-owned copy を作る前に byte length を検証する。
オブジェクトは非対応。bridge の正確なシグネチャは
[reference implementation](moonbit-poc/interop/main.mbt) を参照。
main-thread / worker executor は非同期 module 準備より前に、引数、ABI、
`signal`、export 名、expected hash を一度だけ読み取って snapshot する。
worker に直接渡した inline `ArrayBuffer` も同時点でコピーするため、呼び出し後の
option / byte mutation は実行へ反映されない。空 module URL や不正な option は
fetch / Worker 生成前に `UnzenRuntimeError` で拒否する。
advanced API の direct `prepare()` も `AbortSignal` を fetch 前に検証し、response body
読み取り失敗を生の例外ではなく `UnzenNetworkError` として返す。
String は Chromium / Firefox で
動作確認済み。Safari は wasm-gc が 18.2+、JS String Builtins が 26.2+ で
対応となり、本プロジェクトでは Safari 未検証。
実行環境が wasm-gc をコンパイルできない場合、または JS String Builtins の compile
option を受理しても適用しない場合は、module load 時に検出して
`UnzenRuntimeError` として返す。後者は compile 後の予約 import
（`wasm:js-string` と文字列定数 namespace）の残存を検査するため、engine 固有の
`LinkError` を呼び出し元へ直接露出しない。

```typescript
server.defineMoonbit('scaleArray', './scale.wasm', {
  exportName: 'scale_double_array',
  abi: { params: ['f64[]', 'scalar'], result: 'f64[]' },
});
```

MoonBit の `link.wasm-gc.imported-string-constants` namespace は、クライアントの
`moonbitImportedStringConstants` と一致させる。既定値は既存の MoonBit fixture と
同じ `_`。別 namespace を選べば `_` を通常 import に使え、文字列定数を import
しない module では `null` で compile option 自体を省略できる。選択した namespace
は文字列定数専用になり、同じ namespace の function import とは併用できない。

```typescript
const client = new UnzenClient({
  endpoint: 'https://example.com/unzen',
  mode: 'production',
  workerUrl: '/worker.js',               // QuickJS worker
  moonbitWorkerUrl: '/moonbit-worker.js', // MoonBit worker (推奨)
  moonbitImportedStringConstants: 'unzen:strings', // MoonBit link 設定と一致
});
```

constructor は component を作る前に option を検証・snapshot する。`endpoint` は credential・
query・fragment のない 2,048 byte 以下の HTTP(S) URL または origin-relative path に限定し、
前後空白と末尾 slash は route 結合前に正規化する。`mode` は `production` / `development` /
`browser-only` に限定される。custom `sandbox` / `moonbitSandbox` は
`execute()` と `dispose()`（および指定した optional method）が callable でなければならない。
custom executor が選ばれた場合、shadow された worker option は評価しない。
直接利用できる `FallbackHandler` / `ManifestFetcher` も同じ endpoint 正規化を行い、
protocol-relative URL、scheme なし相対 path、不正 endpoint を同期的に拒否する。

`/moonbit-worker.js` は `packages/client/dist/moonbit-worker.js` をサーバーから
配信する（`npm run build -w @unzen/client` で生成。demo サーバーは
`/moonbit-worker.js` で配信済み）。Worker protocol v3 は配列 ABI を含むため、
client bundle と worker bundle は必ず同じ build/version から同時配信する。
worker は request の protocol version / 正のsafe generationを処理前に検証し、client は
response の同じenvelopeに加えてsuccess/error metadataの整合性も検証する。不一致は
fail closed で拒否される。成功した`null`はerrorと区別され、そのまま呼び出し元へ返る。
advanced API から worker executor を直接構築する場合、`workerUrl`は空文字不可、
timer値は1〜2,147,483,647msの整数、`maxQueueSize`は0以上のsafe integer、
`hardKillMultiplier`は正の有限値で、`timeout`との積もtimer範囲内である必要がある。
QuickJS executor の直接 `execute()` は非空 code と最大128引数を受け付け、worker 初期化・
queue 登録前に indexed copy と JSON round-trip で引数を所有する。循環値や BigInt など
JSON 化できない入力は worker を作らず `UnzenFunctionError` で拒否する。per-call option bag と
`signal` も code/args より先に一度だけ検証・snapshot し、Mock と Worker で同じ error 契約にする。

## 永続 code / Wasm キャッシュ

`@unzen/client` は versioned function code と MoonBit Wasm 専用の classic Service
Worker bundle を出力する。root scope で明示的に登録する:

```typescript
import { registerUnzenCacheWorker } from '@unzen/client';

await registerUnzenCacheWorker({
  workerUrl: '/unzen-cache-worker.js',
  scope: '/',
});
```

`packages/client/dist/unzen-cache-worker.js` は JavaScript MIME type、
`Cache-Control: no-cache` で配信する。root 以外に配置して `/` scope を指定する場合は
`Service-Worker-Allowed: /` も必要になる。
registration option bag と `navigator.serviceWorker.register` は登録前に一度だけ
snapshot・検証し、空値や unreadable getter を副作用前に `TypeError` で拒否する。

`ManifestFetcher` は HTTP JSON をそのまま信用せず、関数名、runtime、正の safe integer
version、canonical SHA-256、HTTP(S) / relative `codeUrl`、`noFallback`、MoonBit 固有の
export / ABI metadata を実行時に検証する。検証後は prototype を持たない関数表へコピーし、
不正な body は ETag とともにキャッシュせず `UnzenNetworkError` で fail closed にする。
cache hit、同時 waiter、304 revalidation、`getEntry()` は entry と MoonBit ABI を含む
caller-owned copy を返し、内部 cache / ETag snapshot を外部 mutation へ公開しない。
304 は対応する `If-None-Match` を実際に送った request でのみ受理する。
direct `ManifestFetcher.fetch(signal)` は signal を HTTP 前に検証する。`CodeFetcher.fetch()` は
QuickJS manifest entry と signal を cache/network 前に検証・snapshot し、非同期応答中の
caller mutation で URL、integrity hash、cache key が変わらないようにする。同じ hash の
同時取得は single-flight 化し、各 caller の cancel はその waiter だけを外し、最後の waiter が
離れた時だけ共有 HTTP request を中止する。

Service Worker の有無にかかわらず、`UnzenClient` はダウンロードした JavaScript と
MoonBit Wasm の生バイトを manifest の `sha256:<64hex>` と照合し、一致した payload
だけを decode / compile / インメモリキャッシュする。不正形式、ハッシュ不一致、
Web Crypto が利用できない環境では fail closed で実行しない。

worker が intercept するのは同一 origin の
`/code/<name>?v=<positive-safe-integer>&h=sha256:<64hex>` のみ。server が 200・
JavaScript/Wasm・`immutable` と認めた応答を URL の SHA-256 と再照合してから
`unzen-code-v2` に保存する。manifest、fallback API、version/hash が欠けた URL、
別 origin の asset は保存しない。`clearUnzenCodeCache()` で Unzen の cache
generation だけを削除できる。この機能は code/Wasm payload の offline 再利用であり、
新規 navigation を完全 offline にするにはアプリ shell と manifest の別戦略が必要。
integrity 用の response clone も宣言値と stream 実 byte 数を 16 MiB に制限し、超過時は
両 response branch を cancel して `502` / `no-store` を返す。`v2` はこの bounded policy 導入前の
cache generation を activation 時に破棄するための世代である。

## プロジェクト構成

```
core/
├── moonbit-poc/           # MoonBit wasm-gc PoC (Phase 3)
│   ├── fibonacci/         # fibonacci ベンチマーク (8.2KB wasm)
│   ├── sort/              # quicksort ベンチマーク (9.0KB wasm)
│   └── benchmark/         # ブラウザベンチマーク UI
├── packages/
│   ├── shared/         # 共有型定義・エラー・セキュリティコード
│   ├── server/         # サーバーSDK (@unzen/server)
│   ├── bundler/        # モジュールバンドラー (@unzen/bundler)
│   └── client/         # クライアントSDK (@unzen/client)
└── demo/               # E2Eデモサーバー
```

## 想定ユースケース

**軽量処理** (50ms):
- **フォームバリデーション**: 複雑なスキーマ検証をブラウザで実行する（サーバーへの往復を削減）
- **価格計算**: 税金・割引・送料をブラウザ内で計算する（即時レスポンス）
- **コンテンツフィルタリング**: スパム判定やNGワード検出を行う

**中量処理** (500ms):
- **JSON Schema 検証**: APIリクエスト検証をブラウザに委譲する
- **データソート**: ダッシュボードの大規模テーブルをソートする
- **テキスト類似度**: Levenshtein距離による重複検出を行う
- **テキスト解析**: 単語数、可読性スコア、Flesch-Kincaid指標を算出する

**重量処理** (2,000ms):
- **暗号ハッシュ**: PBKDF2等でパスワードをハッシュ化する
- **画像メタデータ抽出**: EXIF解析、GPS位置情報を除去する

## 類似プロジェクトとの違い

| プロジェクト | アプローチ | unzen との違い |
|---|---|---|
| Qwik | `$` 境界でクライアント実行を制御 | UIレンダリング専用。汎用計算ではない |
| React RSC | `"use server"` / `"use client"` | クライアント→サーバー方向。逆 |
| wasi-worker | WASIバイナリをブラウザで実行 | 低レベルランタイムのみ。DXフレームワークなし |
| Comlink | Web Worker を透過的に呼び出し | ブラウザ内のスレッド間のみ。サーバー委任なし |

## 開発

```bash
# インストール
npm install

# テスト実行
npx vitest run

# ビルド
npm run build

# デモ起動
cd demo && npm run dev
# → http://localhost:3000
```

## ドキュメント

詳細は `docs/` ディレクトリにまとめています。[ドキュメント一覧](docs/INDEX.md) を参照。

- [設計書](docs/design.md) - アーキテクチャ、サンドボックス、SDK設計
- [アーキテクチャ](docs/ARCHITECTURE.md) - `WebWorkerSandboxExecutor` の single-flight / queue / timeout / cancel / generation ライフサイクル (issue #106)、`UnzenClient` の AbortSignal / 実行イベント / fallback diagnostics (issue #105)
- [サンプル関数リファレンス](docs/sample-functions.md) - 全サンプル関数の仕様・入出力・例
- [Next.js App Router 統合ガイド](docs/nextjs-integration.md) - Next.js への組み込み手順
- [Next.js App Router 実行サンプル](examples/nextjs-app-router/README.md) - manifest/code/exec と browser diagnostics を確認できる最小構成
- [モジュールバンドラー](docs/bundler.md) - @unzen/bundler の設計と使い方
- [セキュリティ制約とユースケース](docs/use-cases-and-constraints.md) - 外部接続禁止ポリシー
- [学術参考文献](docs/references.md) - Wasm セキュリティ、サンドボックス関連論文
- [MoonBit wasm-gc PoC](moonbit-poc/README.md) - Phase 3 MoonBit ランタイム検証 (ビルド済み、ブラウザベンチマーク付き)
- [E2E デモ](demo/README.md) - デモページの UI アーキテクチャ・状態機械・統計・テストの説明

## ライセンス

未定 (MIT or AGPL を検討中)
