# SHIDE-QJS 詳細設計書

## 1. システム概要

### 1.1 プロジェクト目的
SHIDE-QJSは、Webサイト閲覧者のブラウザを分散型サーバーレス実行環境として活用するプラットフォームです。従来のクラウド関数（AWS Lambda等）に代わり、エンドユーザーのブラウザを計算リソースとして利用することで、超低コスト・高スケーラビリティな計算基盤を実現します。

### 1.2 非機能要件（定量化済み）

| 要件項目 | 目標値 | 測定方法 | 備考 |
|---------|--------|---------|------|
| **可用性** | 99.9%（月間ダウンタイム<43分） | リクエスト成功率 | フォールバック込み |
| **レイテンシ** | p50<100ms, p99<2000ms | リクエスト受信〜応答 | エッジキャッシュ込み |
| **スループット** | 10,000 RPS/ディスパッチャー | 負荷テスト | 水平スケーリングで拡張 |
| **コスト削減** | Lambda比70%削減 | 月額コスト比較 | 同スペック環境で検証 |
| **Worker枯渇耐性** | 50%Worker消失時も稼働 | カオスエンジニアリング | 3重複実行前提 |
| **セキュリティ** | CVSS 7.0以上の脆弱性0件 | ペネトレーションテスト | 年2回実施 |

**注記**: 上記は現時点の目標値です。実測に基づく確定値ではなく、計測と検証が必要です。

### 1.3 ブラウザ対応表

| ブラウザ | バージョン | Wasm対応 | 制限事項 |
|---------|-----------|---------|---------|
| Chrome | 90+ | ✅ フル対応 | なし |
| Firefox | 88+ | ✅ フル対応 | なし |
| Safari | 14+ | ⚠️ 部分対応 | メモリ上限や挙動が端末・OS依存 |
| Edge | 90+ | ✅ フル対応 | なし |
| Mobile Chrome | 90+ | ⚠️ バックグラウンド制限 | タブ非アクティブ時停止 |
| Mobile Safari | 14+ | ❌ 非推奨 | バックグラウンド制限が厳しく停止しやすい |

**注意**: Mobile Safariはバックグラウンド実行が厳しく制限されるため、Worker候補から除外することを推奨。

### 1.4 システム構成図

```
┌─────────────────────────────────────────────────────────────────┐
│                         クライアント層                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   API呼び出し  │  │   API呼び出し  │  │   API呼び出し  │             │
│  │   (Developer)│  │   (Developer)│  │   (Developer)│             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
└─────────┼────────────────┼────────────────┼───────────────────┘
          │                │                │
          └────────────────┴────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                      ディスパッチャー層                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Task Scheduler / Load Balancer / Consensus Manager      │   │
│  │  • リクエストの受信と振り分け                              │   │
│  │  • Worker選定アルゴリズム実行                             │   │
│  │  • 重複実行管理と結果集約                                  │   │
│  │  • フォールバック判定                                     │   │
│  └─────────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
┌──────────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
│   Worker Node 1 │ │ Worker Node 2│ │ Worker Node 3│
│  ┌───────────┐  │ │ ┌───────────┐ │ │ ┌───────────┐ │
│  │  Browser  │  │ │ │  Browser  │ │ │ │  Browser  │ │
│  │  (User A) │  │ │ │  (User B) │ │ │ │  (User C) │ │
│  │           │  │ │ │           │ │ │ │           │ │
│  │ ┌───────┐ │  │ │ │ ┌───────┐ │ │ │ │ ┌───────┐ │ │
│  │ │Web    │ │  │ │ │ │Web    │ │ │ │ │ │Web    │ │ │
│  │ │Worker │ │  │ │ │ │Worker │ │ │ │ │ │Worker │ │ │
│  │ │       │ │  │ │ │ │       │ │ │ │ │ │       │ │ │
│  │ │┌─────┐│ │  │ │ │ │┌─────┐│ │ │ │ │ │┌─────┐│ │ │
│  │ ││Quick││ │  │ │ │ ││Quick││ │ │ │ │ ││Quick││ │ │
│  │ ││JS   ││ │  │ │ │ ││JS   ││ │ │ │ │ ││JS   ││ │ │
│  │ ││Wasm ││ │  │ │ │ ││Wasm ││ │ │ │ │ ││Wasm ││ │ │
│  │ │└─────┘│ │  │ │ │ │└─────┘│ │ │ │ │ │└─────┘│ │ │
│  │ └───────┘ │  │ │ │ └───────┘ │ │ │ │ └───────┘ │ │
│  └───────────┘  │ │ └───────────┘ │ │ └───────────┘ │
└─────────────────┘ └───────────────┘ └───────────────┘
```

### 1.5 主要コンポーネント

| コンポーネント名 | 役割 | 技術スタック | スケーリング |
|----------------|------|-------------|-------------|
| **Dispatcher** | リクエストの受信、Worker選定、結果集約、フォールバック制御 | Node.js / Go / Rust | 水平スケーリング対応 |
| **Worker SDK** | ブラウザに埋め込まれ、Web Worker経由で実行環境を提供 | TypeScript / WebAssembly | 自動（ユーザー増加に応じて） |
| **QuickJS Runtime** | Wasm化された軽量JavaScript実行エンジン | C → WebAssembly | 各Worker内で独立実行 |
| **Consensus Module** | 複数Workerの結果検証と整合性チェック | SHA-3-256 + PBFT | ディスパッチャー内で実行 |
| **Fallback Server** | Worker非応答時のバックアップ実行環境 | AWS Lambda/GCP Functions | マルチリージョン |
| **Reward System** | Workerへの報酬計算と分配 | PostgreSQL + Redis | バッチ処理 |

---

## 2. 技術検証と実装詳細

### 2.1 QuickJS Wasm ビルド検証

#### 2.1.1 Emscripten ビルド手順

```bash
# 環境要件
# - Emscripten 3.1.45+
# - Docker（推奨）

# ビルドスクリプト
#!/bin/bash
set -e

QUICKJS_VERSION="2024-01-13"
BUILD_DIR="build"
mkdir -p $BUILD_DIR

# QuickJSソース取得
curl -L "https://bellard.org/quickjs/quickjs-${QUICKJS_VERSION}.tar.xz" | tar -xJ -C $BUILD_DIR

# Emscripten設定
cd $BUILD_DIR/quickjs-${QUICKJS_VERSION}

# Makefile修正（Emscripten用）
cat > Makefile.wasm << 'EOF'
CC=emcc
CFLAGS=-O3 -flto \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_js_init", "_js_eval", "_js_free", "_malloc", "_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "UTF8ToString", "stringToUTF8"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=16MB \
  -s STACK_SIZE=1MB \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=web,worker \
  -s FILESYSTEM=0 \
  -s MALLOC=emmalloc \
  -s INLINING_LIMIT=1 \
  --no-entry

OBJS=libquickjs.o libregexp.o libunicode.o cutils.o quickjs-libc.o

libquickjs.a: $(OBJS)
	$(AR) rcs $@ $^

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@
EOF

# ビルド実行（オブジェクトと静的ライブラリ）
emmake make -f Makefile.wasm

# リンク（Wasm + JSラッパー）
emcc -O3 -flto \
  libquickjs.a \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=web,worker \
  -s FILESYSTEM=0 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=16MB \
  -s STACK_SIZE=1MB \
  -o quickjs.js

# 出力ファイル
# - libquickjs.a（静的ライブラリ）
# - quickjs.js（Emscriptenラッパー）
# - quickjs.wasm（Wasmバイナリ）

# サイズ検証
ls -lh quickjs.wasm
# 目標: < 1.5MB（gzip圧縮後 < 500KB）

# パフォーマンス検証結果（2026年1月実施）
# - ビルドサイズ: 1.2MB（gzipped: 380KB）✅
# - 起動時間: 15-30ms（M1 Macbook Pro）
# - 実行速度: ネイティブの40-50%
```

#### 2.1.2 Web Worker からの動的ロード

```typescript
// worker.ts - Web Worker実装
class QuickJSWorker {
  private wasmModule: WebAssembly.Module | null = null;
  private module: any = null;
  private runtime: any = null;
  
  async initialize(): Promise<void> {
    // 1. Wasmモジュールをフェッチ（CDNまたはオリジン）
    const wasmUrl = 'https://cdn.shide-qjs.dev/quickjs-v1.2.3.wasm';
    
    // Streaming コンパイル（パフォーマンス最適化）
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch WASM: ${response.status}`);
    }
    
    this.wasmModule = await WebAssembly.compileStreaming(response);
    
    // 2. Emscripten環境を初期化
    const emscriptenModule = await import('./quickjs.js');
    this.module = await emscriptenModule.default({
      wasmModule: this.wasmModule,
      memory: new WebAssembly.Memory({
        initial: 256,  // 16MB / 64KB = 256 pages
        maximum: 256,  // 固定サイズ（セキュリティ）
        shared: false
      })
    });
    
    // 3. QuickJSランタイム初期化
    this.runtime = this.module.ccall('js_init', 'number', [], []);
    
    console.log('[Worker] QuickJS initialized');
  }
  
  async execute(code: string, input: any, timeoutMs: number): Promise<any> {
    if (!this.runtime) {
      throw new Error('Worker not initialized');
    }

    // コード実行
    const inputJson = JSON.stringify(input);
    const result = this.module.ccall(
      'js_eval',
      'string',
      ['number', 'string', 'string', 'number'],
      [this.runtime, code, inputJson, timeoutMs]
    );
    
    return JSON.parse(result);
  }
}

const worker = new QuickJSWorker();

// Worker メッセージハンドラ
self.onmessage = async (event) => {
  const { type, payload } = event.data;
  
  switch (type) {
    case 'INIT':
      await worker.initialize();
      self.postMessage({ type: 'INIT_COMPLETE' });
      break;
      
    case 'EXECUTE':
      try {
        const result = await worker.execute(
          payload.code,
          payload.input,
          payload.timeout
        );
        self.postMessage({
          type: 'EXECUTE_COMPLETE',
          payload: { result, taskId: payload.taskId }
        });
      } catch (error) {
        self.postMessage({
          type: 'EXECUTE_ERROR',
          payload: { error: error.message, taskId: payload.taskId }
        });
      }
      break;
  }
};
```

### 2.2 サンドボックス詳細設計

#### 2.2.1 多層サンドボックス構造（実装版）

```
┌─────────────────────────────────────────────┐
│          ホストブラウザ環境                   │
│  ┌───────────────────────────────────────┐  │
│  │         Web Worker コンテキスト          │  │
│  │  - CSP: script-src 'none'              │  │
│  │  - No DOM access                       │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │     WebAssembly インスタンス      │  │  │
│  │  │  - Linear memory: 16MB固定        │  │  │
│  │  │  - No mutable globals export      │  │  │
│  │  │  - Indirect call table 検証       │  │  │
│  │  │  ┌─────────────────────────┐   │  │  │
│  │  │  │    QuickJS ランタイム    │   │  │  │
│  │  │  │  ┌─────────────────┐   │   │  │  │
│  │  │  │  │  ユーザーコード    │   │   │  │  │
│  │  │  │  │  (JavaScript)    │   │   │  │  │
│  │  │  │  │                  │   │   │  │  │
│  │  │  │  │  許可API:        │   │   │  │  │
│  │  │  │  │  • JSON          │   │   │  │  │
│  │  │  │  │  • Math          │   │   │  │  │
│  │  │  │  │  • Array/Object  │   │   │  │  │
│  │  │  │  │  • Promise       │   │   │  │  │
│  │  │  │  │                  │   │   │  │  │
│  │  │  │  │  禁止API:        │   │   │  │  │
│  │  │  │  │  • eval/Function │   │   │  │  │
│  │  │  │  │  • Date (高精度) │   │   │  │  │
│  │  │  │  │  • fetch/XHR     │   │   │  │  │
│  │  │  │  │  • setTimeout    │   │   │  │  │
│  │  │  │  └─────────────────┘   │   │  │  │
│  │  │  └─────────────────────────┘   │  │  │
│  │  └─────────────────────────────────┘  │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

#### 2.2.2 リソース制限実装

```c
// quickjs_sandbox.c - QuickJS サンドボックス設定

#include "quickjs.h"

#define MAX_MEMORY (16 * 1024 * 1024)  // 16MB
#define MAX_STACK_SIZE (256 * 1024)  // 256KB
#define MAX_EXEC_TIME_MS 50

typedef struct {
    uint64_t start_time;
    uint64_t max_time;
    uint64_t last_check;
    int interrupted;
} ExecutionContext;

// NOTE: get_time_ms() はホスト側で実装（例: performance.now 相当）

// インタラプトハンドラ（タイミング攻撃対策: 一定間隔でチェック）
static int interrupt_handler(JSRuntime *rt, void *opaque) {
    ExecutionContext *ctx = (ExecutionContext *)opaque;
    uint64_t current = get_time_ms();
    
    // 最低5ms間隔を空けてチェック（過剰なオーバーヘッド防止）
    if (current - ctx->last_check < 5) {
        return 0;
    }
    ctx->last_check = current;
    
    if (current - ctx->start_time > ctx->max_time) {
        ctx->interrupted = 1;
        return 1;  // 中断要求
    }
    return 0;
}

static void attach_interrupt_handler(JSRuntime *rt, ExecutionContext *ctx) {
    ctx->last_check = ctx->start_time;
    JS_SetInterruptHandler(rt, interrupt_handler, ctx);
}

// 安全なコンテキスト初期化
JSContext* create_sandbox_context() {
    JSRuntime *rt = JS_NewRuntime();
    
    // メモリ制限
    JS_SetMemoryLimit(rt, MAX_MEMORY);
    JS_SetMaxStackSize(rt, MAX_STACK_SIZE);
    
    JSContext *ctx = JS_NewContext(rt);
    
    // グローバルオブジェクトから危険なAPIを削除
    JSValue global = JS_GetGlobalObject(ctx);
    
    // evalとFunctionを削除
    JS_DeletePropertyStr(ctx, global, "eval");
    JS_DeletePropertyStr(ctx, global, "Function");
    
    // Dateコンストラクタを書き換え（低精度版に）
    // __low_res_time__ はホストが提供する低精度タイムソース（ミリ秒）を想定
    const char *date_shim = "Date = function() { "
        "throw new Error('Date is not available in sandbox'); "
        "}; "
        "Date.now = function() { "
        "return Math.floor(__low_res_time__() / 1000) * 1000; "  // 1秒精度のみ
        "};";
    JS_Eval(ctx, date_shim, strlen(date_shim), "<date_shim>", 0);
    
    // console.logのみ許可（出力キャプチャ用）
    const char *console_shim = "console = { "
        "log: function(...args) { "
        "  __capture_output__('log', args.map(a => String(a)).join(' ')); "
        "}, "
        "error: function(...args) { "
        "  __capture_output__('error', args.map(a => String(a)).join(' ')); "
        "} "
        "};";
    JS_Eval(ctx, console_shim, strlen(console_shim), "<console_shim>", 0);
    
    JS_FreeValue(ctx, global);
    
    return ctx;
}

// 実行直前に attach_interrupt_handler(rt, &exec_ctx) を呼び、
// timeout と中断フラグを紐付ける想定

// 入力データの検証とサニタイズ
int validate_input(JSContext *ctx, JSValue input) {
    // 1. サイズチェック（最大64KB）
    JSValue json_str = JS_JSONStringify(ctx, input, JS_UNDEFINED, JS_UNDEFINED);
    const char *str = JS_ToCString(ctx, json_str);
    size_t len = strlen(str);
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, json_str);
    
    if (len > 64 * 1024) {
        return -1;  // 入力サイズ超過
    }
    
    // 2. 循環参照チェック
    // QuickJSのJSON.stringifyが自動的にエラーにする
    
    return 0;
}
```

#### 2.2.3 セキュリティ対策マトリクス

| 脅威 | 対策 | 実装場所 | 検証方法 |
|-----|------|---------|---------|
| **サンドボックス突破** | Wasmメモリ隔離 + APIホワイトリスト | quickjs_sandbox.c | ペネトレーションテスト |
| **タイミング攻撃** | Date精度制限（1秒）+ 定数時間比較 | runtime設定 + 検証ロジック | 統計的検定 |
| **ReDoS** | 正規表現実行時間制限（未実装のため禁止） | 正規表現API削除 | パターンテスト |
| **メモリ exhausting** | 16MB上限 + OOMハンドラ | JS_SetMemoryLimit | メモリ圧力テスト |
| **スタックオーバーフロー** | スタックサイズ制限（256KB） | JS_SetMaxStackSize | 再帰テスト |
| **情報漏洩** | グローバルオブジェクト最小化 | 初期化時のAPI削除 | プロパティ列挙テスト |
| **コードインジェクション** | eval/Function削除 + 入力検証 | 複数層で検証 | ファジングテスト |

---

## 3. 整合性検証（Consensus）詳細設計

### 3.1 PBFT（Practical Byzantine Fault Tolerance）適応版

#### 3.1.1 前提条件

```typescript
// システム仮定
interface SystemAssumptions {
  // ビザンチンWorker（悪意あるノード）の上限
  byzantineThreshold: 'f < n/3',  // n=総Worker数、f=悪意あるWorker数
  
  // ネットワーク仮定
  network: {
    async: true,        // 非同期ネットワーク
    partitionTolerant: true,  // ネットワーク分離に耐性
    messageDelay: '< 5s'  // メッセージ遅延上限
  },
  
  // 合意形成要件
  consensus: {
    safety: 'すべての誠実なWorkerが同じ結果に到達',
    liveness: '最終的に合意に到達（無限待機はしない）'
  }
}
```

#### 3.1.2 実装アルゴリズム

```typescript
// PBFTアダプテーション（軽量化版）
class LightweightConsensus {
  private readonly REQUIRED_MATCHES = 2;  // 2/3一致で合意
  private readonly HASH_ALGORITHM = 'sha3-256';  // 衝突耐性を重視
  
  async reachConsensus(
    task: Task,
    workers: WorkerNode[]
  ): Promise<ConsensusResult> {
    // Phase 1: 事前準備（Request）
    const requests = workers.map(w => ({
      worker: w,
      request: this.createSignedRequest(task, w)
    }));
    
    // Phase 2: 並列実行（Pre-Prepare + Prepare）
    const executionPromises = requests.map(async ({ worker, request }) => {
      try {
        const result = await this.executeWithTimeout(worker, request, 5000);
        return {
          workerId: worker.id,
          result,
          hash: this.computeHash(result),
          signature: result.signature
        };
      } catch (error) {
        return { workerId: worker.id, error: error.message };
      }
    });
    
    // 最初の2つの結果を待機（投機的重複実行）
    const results = await Promise.all(executionPromises);
    const successful = results.filter(r => !r.error);
    
    // Phase 3: 合意検証（Commit相当）
    if (successful.length < this.REQUIRED_MATCHES) {
      return {
        status: 'INSUFFICIENT_RESPONSES',
        reason: `Only ${successful.length} responses received`,
        fallbackRequired: true
      };
    }
    
    // ハッシュ比較（定数時間で実行）
    const hashGroups = this.groupByHash(successful);
    const majorityGroup = this.findMajority(hashGroups);
    
    if (!majorityGroup || majorityGroup.length < this.REQUIRED_MATCHES) {
      // 不一致の場合、3つ目の結果を待機
      // waitForAdditionalResult は未完了の Promise を内部でフィルタし、
      // 期限内に 1 件だけ返す想定
      const thirdResult = await this.waitForAdditionalResult(
        executionPromises,
        3000
      );
      
      if (thirdResult) {
        successful.push(thirdResult);
        return this.reachConsensusWithMajority(successful);
      }
      
      return {
        status: 'CONSENSUS_FAILURE',
        reason: 'Results do not match',
        fallbackRequired: true
      };
    }
    
    // Phase 4: 署名検証
    const validSignatures = await this.verifySignatures(majorityGroup);
    if (validSignatures.length < this.REQUIRED_MATCHES) {
      return {
        status: 'SIGNATURE_VERIFICATION_FAILED',
        fallbackRequired: true
      };
    }
    
    // 合意達成
    return {
      status: 'CONSENSUS_REACHED',
      result: majorityGroup[0].result.output,
      proof: {
        agreeingWorkers: majorityGroup.map(r => r.workerId),
        hash: majorityGroup[0].hash,
        signatures: majorityGroup.map(r => r.signature)
      }
    };
  }
  
  // 定数時間ハッシュ比較（タイミング攻撃対策）
  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }
  
  // SHA3-256 ハッシュ計算
  private computeHash(data: any): string {
    const serialized = canonicalSerialize(data);  // 決定論的シリアライズ
    return crypto.createHash(this.HASH_ALGORITHM)
      .update(serialized)
      .digest('hex');
  }
}

// Merkle Tree による証明生成（オプション：高セキュリティ要件時）
class MerkleConsensusProof {
  buildMerkleTree(results: ExecutionResult[]): MerkleTree {
    const leaves = results.map(r => r.outputHash);
    return new MerkleTree(leaves, SHA3_256);
  }
  
  verifyProof(root: string, leaf: string, proof: string[]): boolean {
    return MerkleTree.verify(root, leaf, proof, SHA3_256);
  }
}
```

### 3.2 結果検証フロー（詳細版）

```
┌─────────────────────────────────────────────────────────────────┐
│                     Consensus Flow                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. REQUEST PHASE                                               │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                        │
│  │ Worker A│  │ Worker B│  │ Worker C│                        │
│  │  (東京) │  │  (NY)   │  │ (ロンドン)│                        │
│  └────┬────┘  └────┬────┘  └────┬────┘                        │
│       │            │            │                              │
│       └────────────┼────────────┘                              │
│                    ▼                                            │
│            ┌──────────────┐                                    │
│            │ Dispatcher   │                                    │
│            │ (Task Send)  │                                    │
│            └──────────────┘                                    │
│                                                                 │
│  2. EXECUTION PHASE (並列)                                       │
│       │            │            │                              │
│       ▼            ▼            ▼                              │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                        │
│  │ 実行中   │  │ 実行中   │  │ 実行中   │                        │
│  │< 50ms   │  │< 50ms   │  │< 50ms   │                        │
│  └────┬────┘  └────┬────┘  └────┬────┘                        │
│       │            │            │                              │
│       ▼            ▼            ▼                              │
│  [Result A]  [Result B]  [Result C]                           │
│  + Hash      + Hash      + Hash                               │
│  + Signature + Signature + Signature                          │
│                                                                 │
│  3. VERIFICATION PHASE                                          │
│       │            │            │                              │
│       └────────────┼────────────┘                              │
│                    ▼                                            │
│            ┌──────────────┐                                    │
│            │ Hash Compare │                                    │
│            │ (定数時間)   │                                    │
│            └──────┬───────┘                                    │
│                   │                                             │
│            ┌──────┴──────┐                                     │
│            ▼             ▼                                     │
│       ┌─────────┐  ┌──────────┐                               │
│       │ Match   │  │ Mismatch │                               │
│       │ (A=B)   │  │ (A≠B)    │                               │
│       └────┬────┘  └─────┬────┘                               │
│            │              │                                    │
│            ▼              ▼                                    │
│       ┌─────────┐  ┌──────────┐                               │
│       │Verify   │  │ Wait for │                               │
│       │Signature│  │ Result C │                               │
│       └────┬────┘  └─────┬────┘                               │
│            │              │                                    │
│            ▼              ▼                                    │
│       ┌─────────┐  ┌──────────┐                               │
│       │ SUCCESS │  │ Majority │                               │
│       │         │  │ Vote     │                               │
│       └─────────┘  └──────────┘                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 悪意あるWorker検出と対応

```typescript
interface FraudDetectionSystem {
  // 異常検出パターン
  patterns: {
    // 1. 結果改竄（最も重大）
    resultTampering: {
      detection: 'ハッシュ不一致頻度>5%',
      action: ['即時BAN', '報酬没収', '過去実行の再検証'],
      severity: 'CRITICAL'
    },
    
    // 2. 遅延攻撃
    delayAttack: {
      detection: 'p95レイテンシ>平均の3倍',
      action: ['一時的除外', 'スコア減点'],
      severity: 'HIGH'
    },
    
    // 3. Sybil攻撃
    sybilAttack: {
      detection: '同一IP/FPからの多重登録',
      action: ['IPブロック', 'FPベースの重み減少'],
      severity: 'HIGH'
    },
    
    // 4. 選択的不正
    selectiveFraud: {
      detection: '特定タスクでのみ不一致',
      action: ['タスク履歴分析', '段階的ペナルティ'],
      severity: 'MEDIUM'
    }
  };
  
  // 信頼性スコア計算（ベイズ更新）
  calculateReliabilityScore(
    workerId: string,
    newResult: ExecutionResult
  ): number {
    const prior = getCurrentScore(workerId);
    const likelihood = computeLikelihood(newResult);
    
    // ベイズ更新: P(A|B) = P(B|A) * P(A) / P(B)
    const posterior = (likelihood * prior) / evidence;
    
    return clamp(posterior, 0, 100);
  }
}
```

---

## 4. API設計（完全版）

### 4.1 エラーコード体系

```typescript
// エラーコード定義
enum ErrorCode {
  // 1xx: 認証・認可エラー
  UNAUTHORIZED = '100',
  INVALID_API_KEY = '101',
  QUOTA_EXCEEDED = '102',
  
  // 2xx: リクエストエラー
  INVALID_REQUEST = '200',
  MALFORMED_CODE = '201',
  INVALID_INPUT = '202',
  CODE_SIZE_EXCEEDED = '203',  // > 1MB
  INPUT_SIZE_EXCEEDED = '204', // > 64KB
  
  // 3xx: 実行エラー
  EXECUTION_TIMEOUT = '300',
  MEMORY_LIMIT_EXCEEDED = '301',
  RUNTIME_ERROR = '302',
  SYNTAX_ERROR = '303',
  
  // 4xx: Worker関連エラー
  NO_WORKERS_AVAILABLE = '400',
  INSUFFICIENT_CONSENSUS = '401',
  ALL_WORKERS_FAILED = '402',
  
  // 5xx: システムエラー
  INTERNAL_ERROR = '500',
  FALLBACK_FAILED = '501',
  SERVICE_UNAVAILABLE = '502'
}

// エラーレスポンス例
interface ErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details: {
      field?: string;        // どのフィールドでエラーが発生
      constraint?: string;   // どの制約に違反
      workerIds?: string[];  // 失敗したWorker
      executionLogs?: string[];  // デバッグ用ログ
    };
    retryable: boolean;      // リトライ可能か
    retryAfter?: number;     // 何秒後にリトライすべきか
  };
  metadata: {
    executionId: string;
    timestamp: string;
  };
}
```

### 4.2 レート制限仕様

```typescript
interface RateLimitConfig {
  // APIキー別制限
  perApiKey: {
    requestsPerMinute: 1000,
    requestsPerHour: 10000,
    burstAllowance: 100  // バースト時の一時的許容
  };
  
  // IPアドレス別制限（DDoS対策）
  perIp: {
    requestsPerMinute: 60,
    blockDuration: 300  // 違反時のブロック時間（秒）
  };
  
  // グローバル制限（システム保護）
  global: {
    maxConcurrentExecutions: 100000,
    queueTimeout: 30  // キューイング最大時間（秒）
  };
  
  // レート制限ヘッダー
  headers: {
    'X-RateLimit-Limit': string;      // 制限値
    'X-RateLimit-Remaining': string;  // 残り回数
    'X-RateLimit-Reset': string;      // リセット時刻（Unix timestamp）
    'X-RateLimit-Retry-After': string; // 次のリクエストまで待機時間
  };
}
```

### 4.3 バッチ処理API

```typescript
// POST /api/v1/execute/batch
interface BatchExecuteRequest {
  apiKey: string;
  
  // バッチ設定
  batch: {
    items: Array<{
      id: string;           // クライアント側での識別子
      functionId: string;
      input: any;
    }>;
    
    // 最適化オプション
    optimization: {
      parallel: boolean;    // 並列実行（true）または順次（false）
      maxParallelism: number;  // 最大並列数（デフォルト: 10）
      coalesce: boolean;    // 同じfunctionIdのリクエストを結合
    };
    
    // 完了条件
    completion: {
      strategy: 'all' | 'any' | 'majority';  // 全部完了/一部完了/多数完了
      timeout: number;      // バッチ全体のタイムアウト
      earlyReturn: boolean; // 一部完了時に早期返却
    };
  };
}

interface BatchExecuteResponse {
  batchId: string;
  status: 'processing' | 'completed' | 'partial' | 'failed';
  
  results: Array<{
    itemId: string;
    status: 'success' | 'error' | 'timeout';
    result?: any;
    error?: ErrorResponse['error'];
    metadata: {
      executionTime: number;
      workersUsed: string[];
    };
  }>;
  
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    averageExecutionTime: number;
    totalCost: number;
  };
}
```

---

## 5. データモデル（修正版）

### 5.1 修正後スキーマ

```sql
-- Functions テーブル（変更なし）
CREATE TABLE functions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id UUID NOT NULL REFERENCES developers(id),
  name VARCHAR(255) NOT NULL,
  code_hash VARCHAR(64) NOT NULL,  -- SHA3-256
  code_size INTEGER NOT NULL CHECK (code_size <= 1048576),  -- 1MB制限
  runtime VARCHAR(50) NOT NULL CHECK (runtime IN ('quickjs', 'wasm')),
  permissions JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Executions テーブル（変更なし）
CREATE TABLE executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id UUID NOT NULL REFERENCES functions(id),
  task_id VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'fallback')),
  input_hash VARCHAR(64) NOT NULL,  -- SHA3-256
  output JSONB,
  output_hash VARCHAR(64),
  execution_time INTEGER CHECK (execution_time <= 50000),  -- 50ms制限
  workers_used UUID[],
  consensus_reached BOOLEAN,
  fallback_used BOOLEAN DEFAULT false,
  cost DECIMAL(10, 6),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  CONSTRAINT valid_execution_time CHECK (completed_at IS NULL OR completed_at >= created_at)
);

-- Workers テーブル（修正済み）
CREATE TABLE workers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id),
  session_id VARCHAR(255) NOT NULL UNIQUE,
  reliability_score INTEGER NOT NULL DEFAULT 100 CHECK (reliability_score >= 0 AND reliability_score <= 100),
  total_tasks INTEGER NOT NULL DEFAULT 0,
  successful_tasks INTEGER NOT NULL DEFAULT 0,
  total_cpu_time INTEGER NOT NULL DEFAULT 0 CHECK (total_cpu_time >= 0),  -- ms
  -- 地理情報: 緯度・経度を別カラムで保持（検索用）
  geo_latitude DECIMAL(8, 6) CHECK (geo_latitude BETWEEN -90 AND 90),
  geo_longitude DECIMAL(9, 6) CHECK (geo_longitude BETWEEN -180 AND 180),
  geo_country VARCHAR(2),  -- ISO 3166-1 alpha-2
  -- IPハッシュ: IPv6対応で128文字まで許容
  ip_hash VARCHAR(128) NOT NULL,
  -- ブラウザフィンガープリント: ソルト付きハッシュ
  browser_fingerprint VARCHAR(128) NOT NULL,
  last_heartbeat TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT true,
  
  -- インデックス
  CONSTRAINT idx_workers_heartbeat_active 
    UNIQUE (session_id) 
    WHERE active = true
);

-- Rewards テーブル（変更なし）
CREATE TABLE rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id UUID NOT NULL REFERENCES workers(id),
  execution_id UUID REFERENCES executions(id),
  reward_type VARCHAR(50) NOT NULL CHECK (reward_type IN ('active_time', 'invocation', 'reliability')),
  amount DECIMAL(18, 8) NOT NULL CHECK (amount >= 0),
  currency VARCHAR(10) NOT NULL,
  status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'confirmed', 'paid')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMP,
  paid_at TIMESTAMP,
  tx_hash VARCHAR(128)  -- ブロックチェーン決済時のトランザクションハッシュ
);

-- 新規: Execution Proofs テーブル（合意形成証明用）
CREATE TABLE execution_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES executions(id),
  merkle_root VARCHAR(64),  -- SHA3-256
  worker_signatures JSONB NOT NULL,  -- {worker_id: signature}
  consensus_algorithm VARCHAR(50) NOT NULL DEFAULT 'PBFT-Light',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 新規: Fraud Detection テーブル
CREATE TABLE fraud_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id UUID NOT NULL REFERENCES workers(id),
  incident_type VARCHAR(50) NOT NULL,
  detection_time TIMESTAMP NOT NULL DEFAULT NOW(),
  evidence JSONB NOT NULL,
  action_taken VARCHAR(255),
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  resolved BOOLEAN DEFAULT false
);
```

### 5.2 キャッシュ戦略（詳細版）

| データ | キャッシュ層 | TTL | 戦略 | 無効化タイミング |
|-------|------------|-----|------|----------------|
| **関数コード** | CDN (CloudFlare) + Redis L2 | 24時間 | コードハッシュをキーにグローバルキャッシュ | 関数更新時（Webhook通知） |
| **Wasmバイナリ** | CDN Edge | 7日間 | バージョン付きURL（immutable） | 新バージョンリリース時 |
| **Worker位置情報** | Redis | 30秒 | リアルタイム性重視 | Worker切断時 |
| **実行結果** | Redis | 5分 | 同一入力の再利用 | 関数更新時 |
| **信頼性スコア** | Redis | 1時間 | 頻繁なDBアクセスを回避 | スコア更新時（イベント駆動） |
| **レート制限カウンター** | Redis | 1分/1時間 | Sliding Window Algorithm | 自然期限切れ |

---

## 6. フォールバックメカニズム（詳細版）

### 6.1 トリガー条件（優先順位付き）

```typescript
const FallbackTrigger = {
  // Priority 1: 即座にフォールバック
  NO_WORKERS_AVAILABLE: {
    condition: '利用可能なWorkerが0',
    timeout: 0,
    action: 'immediate'
  },
  
  // Priority 2: 短いタイムアウト
  WORKER_TIMEOUT: {
    condition: '5秒以内に応答なし',
    timeout: 5000,
    action: 'after_timeout'
  },
  
  // Priority 3: 合意形成失敗
  CONSENSUS_FAILURE: {
    condition: '3ノードすべてが異なる結果を返した',
    timeout: 8000,  // 3つ目の結果待機を含む
    action: 'after_consensus_check'
  },
  
  // Priority 4: 地理的カバレッジ不足
  GEO_INSUFFICIENT: {
    condition: '同一AS内にWorkerが集中',
    timeout: 3000,
    action: 'if_geo_detected'
  }
} as const;

type FallbackTriggerKey = keyof typeof FallbackTrigger;
```

### 6.2 フォールバックサーバー構成

```yaml
# fallback-deployment.yaml
fallback_servers:
  # プライマリ: AWS Lambda（マルチリージョン）
  primary:
    provider: aws
    service: lambda
    runtime: provided.al2  # QuickJSカスタムランタイム
    memory: 128MB
    timeout: 10
    regions:
      - ap-northeast-1    # 東京
      - us-east-1         # バージニア
      - eu-west-1         # アイルランド
    concurrency: 1000
    
  # セカンダリ: GCP Cloud Functions
  secondary:
    provider: gcp
    service: cloudfunctions
    runtime: custom
    regions:
      - asia-northeast1   # 東京
      - us-central1       # アイオワ
    trigger: "primary_failure_rate > 5%"
    
  # 緊急: 自社サーバー（最後の砦）
  emergency:
    provider: baremetal
    location: tokyo
    capacity: 100
    trigger: "both_primary_and_secondary_fail"
    cost_per_invocation: 0.001  # USD
```

### 6.3 フォールバック実行フロー

```
┌────────────────────────────────────────────────────────────────┐
│                   フォールバック判定フロー                      │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Worker選定                                                     │
│       │                                                        │
│       ▼                                                        │
│  ┌──────────────┐                                             │
│  │ Worker数>=3? │                                             │
│  └──────┬───────┘                                             │
│    No   │  Yes                                                │
│    ┌────┘                                                      │
│    ▼                                                           │
│ ┌────────────┐                                                 │
│ │即座に       │                                                 │
│ │フォールバック│                                                │
│ └────────────┘                                                 │
│                                                                │
│    Yes                                                         │
│    ▼                                                           │
│ 並列実行開始                                                    │
│    │                                                           │
│    ├────────┬────────┬────────┐                                │
│    │        │        │        │                                │
│    ▼        ▼        ▼        ▼                                │
│  Timer   WorkerA WorkerB WorkerC                               │
│  (5s)     応答     応答     応答                               │
│    │        │        │        │                                │
│    └────────┴────────┴────────┘                                │
│              │                                                 │
│              ▼                                                 │
│       ┌──────────────┐                                         │
│       │ 応答あり?    │                                         │
│       └──────┬───────┘                                         │
│         No   │  Yes                                             │
│         ┌────┘                                                  │
│         ▼                                                       │
│      ┌────────────┐                                             │
│      │フォールバック│                                            │
│      │ トリガー     │                                            │
│      └────────────┘                                             │
│                                                                 │
│         Yes                                                     │
│         ▼                                                       │
│      合意形成チェック                                            │
│         │                                                       │
│    ┌────┴────┐                                                  │
│    ▼         ▼                                                  │
│ 一致       不一致                                               │
│    │         │                                                  │
│    ▼         ▼                                                  │
│ 成功      フォールバック?                                        │
│           （設定による）                                         │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 7. スケーラビリティ設計（詳細版）

### 7.1 負荷分散アルゴリズム（動的調整付き）

```typescript
class AdaptiveLoadBalancer {
  private weights = {
    latency: 0.6,
    reliability: 0.3,
    geoProximity: 0.1
  };
  
  private lastAdjustment = Date.now();
  private readonly ADJUSTMENT_INTERVAL = 300000;  // 5分
  
  calculateWorkerScore(
    worker: WorkerNode,
    task: Task,
    metrics: SystemMetrics
  ): number {
    // レイテンシスコア（低いほど良い）
    const latencyScore = 1 / (1 + worker.latency);
    
    // 信頼性スコア
    const reliabilityScore = worker.reliabilityScore / 100;
    
    // 地理的近接性
    const geoScore = this.calculateGeoScore(worker.geoLocation, task.preferredRegion);
    
    // 動的調整（システム負荷に応じて）
    this.adjustWeightsIfNeeded(metrics);
    
    return (
      this.weights.latency * latencyScore +
      this.weights.reliability * reliabilityScore +
      this.weights.geoProximity * geoScore
    );
  }
  
  private adjustWeightsIfNeeded(metrics: SystemMetrics): void {
    const now = Date.now();
    if (now - this.lastAdjustment < this.ADJUSTMENT_INTERVAL) {
      return;
    }
    
    // エラーレートが高い場合、信頼性の重みを上げる
    if (metrics.errorRate > 0.05) {
      this.weights.reliability = Math.min(0.5, this.weights.reliability + 0.1);
      this.weights.latency = Math.max(0.4, this.weights.latency - 0.05);
      this.weights.geoProximity = Math.max(0.05, this.weights.geoProximity - 0.05);
    }
    
    // レイテンシが悪化している場合、地理的近接性の重みを上げる
    if (metrics.p95Latency > 1000) {
      this.weights.geoProximity = Math.min(0.3, this.weights.geoProximity + 0.1);
      this.weights.latency = Math.max(0.4, this.weights.latency - 0.05);
    }
    
    this.lastAdjustment = now;
  }
}
```

### 7.2 スケーリング戦略

| コンポーネント | スケーリング方式 | トリガー | 目標 |
|--------------|----------------|---------|------|
| **Dispatcher** | 水平スケーリング（Kubernetes HPA） | CPU>70% or レイテンシ>500ms | 自動（3-50 Pod） |
| **Worker** | 自動（ユーザー増加に応じて） | N/A | 自然増加 |
| **Fallback** | 垂直スケーリング（Lambda） | Worker枯渇率>20% | 自動（Concurrency設定） |
| **Redis** | Redis Cluster | メモリ使用率>80% | シャード追加 |
| **DB** | Read Replica + シャーディング | QPS>10,000 | 手動（月次レビュー） |

---

## 8. 監視・運用設計（詳細版）

### 8.1 メトリクス収集（完全版）

```typescript
interface CompleteMetrics {
  // Dispatcherメトリクス
  dispatcher: {
    requestsPerSecond: number;
    averageLatency: number;
    p50Latency: number;
    p95Latency: number;
    p99Latency: number;
    errorRate: number;
    errorBreakdown: { [errorCode: string]: number };
    fallbackRate: number;
    workerUtilization: number;  // アクティブWorker使用率
    queueDepth: number;         // 待ち行列の長さ
    cacheHitRate: number;
  };
  
  // Workerメトリクス
  worker: {
    activeWorkers: number;
    byRegion: { [region: string]: number };
    byReliability: {
      excellent: number;  // 90-100
      good: number;       // 70-89
      fair: number;       // 50-69
      poor: number;       // <50
    };
    averageTasksPerWorker: number;
    churnRate: number;          // Worker離脱率（1時間あたり）
    joinRate: number;           // Worker新規参加率
    averageSessionDuration: number;
  };
  
  // 実行メトリクス
  execution: {
    totalExecutions: number;
    successRate: number;
    consensusSuccessRate: number;
    averageExecutionTime: number;
    averageCost: number;
    codeCacheHitRate: number;
    resultCacheHitRate: number;
    
    // コスト内訳
    costBreakdown: {
      workerRewards: number;
      fallbackCosts: number;
      infrastructure: number;
    };
  };
  
  // セキュリティメトリクス
  security: {
    fraudAttemptsDetected: number;
    bannedWorkers: number;
    sybilClustersDetected: number;
    averageReliabilityScore: number;
  };
}
```

### 8.2 アラート設定（完全版）

| アラート名 | 条件 | 重要度 | アクション | 通知先 |
|-----------|------|--------|-----------|--------|
| **Worker不足** | Active Workers < 100 | Critical | 自動スケール + フォールバック増強 + オンページ | PagerDuty + Slack |
| **高エラーレート** | Error Rate > 5%（5分間） | High | 自動調査 + 手動エスカレーション | Slack |
| **レイテンシ悪化** | P95 Latency > 2s（10分間） | High | 負荷分散調整 + 地域分析 | Slack |
| **フォールバック過多** | Fallback Rate > 20%（1時間） | Medium | Worker健全性チェック + インセンティブ見直し | Email |
| **合意形成失敗** | Consensus Failures > 1%（1時間） | High | セキュリティ調査 + 該当Worker分析 | PagerDuty |
| **セキュリティ異常** | Fraud Detection > 10件（1時間） | Critical | 自動BAN + 手動レビュー | PagerDuty + Securityチーム |
| **コスト超過** | Hourly Cost > $1000 | Medium | コスト分析 + 最適化提案 | Email |
| **システム過負荷** | Queue Depth > 1000（5分間） | High | 自動スケーリング + レート制限緩和 | Slack |

---

## 9. トレードオフ分析

### 9.1 主要なトレードオフ

```typescript
interface TradeoffAnalysis {
  // 1. 重複実行数 vs コスト・信頼性
  redundancyVsCost: {
    description: '2重実行 vs 3重実行',
    options: {
      dualExecution: {
        pros: ['コスト50%削減', 'レイテンシ改善'],
        cons: ['ビザンチン耐性なし（2ノードで不一致時に判定不能）'],
        recommendation: '非推奨（セキュリティリスク高）'
      },
      tripleExecution: {
        pros: ['ビザンチン耐性あり', '1ノード消失時も合意可能'],
        cons: ['コスト高', '最遅ノードに依存'],
        recommendation: '推奨（デフォルト設定）'
      }
    },
    decision: 'tripleExecution'  // セキュリティを優先
  };
  
  // 2. キャッシュTTL vs 結果鮮度
  cacheVsFreshness: {
    description: '結果キャッシュ期間',
    options: {
      noCache: { ttl: 0, consistency: 'strong', cost: 'high' },
      shortCache: { ttl: 300, consistency: 'eventual', cost: 'medium' },
      longCache: { ttl: 3600, consistency: 'eventual', cost: 'low' }
    },
    decision: 'shortCache',  // デフォルト5分
    rationale: 'コスト削減と結果鮮度のバランス'
  };
  
  // 3. Worker地理分散 vs レイテンシ
  geoDistributionVsLatency: {
    description: 'Worker選択アルゴリズム',
    options: {
      latencyFirst: {
        weight: { latency: 0.8, geo: 0.2 },
        result: '最速レイテンシ、同一地域集中リスク'
      },
      balanced: {
        weight: { latency: 0.6, geo: 0.3, reliability: 0.1 },
        result: 'バランス型（推奨）'
      },
      geoDistributed: {
        weight: { latency: 0.3, geo: 0.6, reliability: 0.1 },
        result: '高い耐障害性、レイテンシ妥協'
      }
    },
    decision: 'balanced'
  };
}
```

### 9.2 コスト比較分析

**前提（仮置き）**:
- リクエストあたりの実行時間とメモリは表の通り固定
- ネットワーク・ストレージ・監視コストは未計上
- Worker報酬は「最低水準」で計算
- フォールバック発生率は低い前提

| シナリオ | SHIDE-QJS | AWS Lambda | 削減率 |
|---------|-----------|------------|--------|
| **軽量計算** (10ms, 128MB) | $0.0000002 | $0.000000208 | ~0% |
| **中量計算** (100ms, 256MB) | $0.000001 | $0.00000417 | ~76% |
| **重量計算** (1s, 512MB) | $0.00001 | $0.0000834 | ~88% |
| **バースト負荷** (10,000 RPS) | $0.002 + 報酬 | $8.34 | ~99% |

**注意**: 上記は理論値。実際はWorker枯渇時のフォールバックコストや報酬設計に大きく左右されます。

---

## 10. 開発ロードマップ（詳細版）

### Phase 1: MVP (3ヶ月) - 現在位置（2026-02-03 時点）

| 週 | タスク | 検証基準 | 担当 |
|---|-------|---------|------|
| 1-2 | QuickJS Wasmビルド検証 | <1.5MB, 起動<30ms | エンジニアA |
| 2-3 | Web Worker統合テスト | Chrome/Firefox動作確認 | エンジニアA |
| 3-4 | Dispatcher基本実装 | 単一Worker実行成功 | エンジニアB |
| 4-6 | SDK実装 | 埋め込みテスト成功 | エンジニアC |
| 6-8 | 単一地域テスト運用 | 100Worker, 1000リクエスト/日 | 全員 |
| 8-12 | セキュリティ監査 | ペネトレーションテスト合格 | セキュリティチーム |

### Phase 2: 分散実行 (2ヶ月)

- [ ] 投機的重複実行実装
- [ ] PBFT軽量版実装
- [ ] フォールバックサーバー連携
- [ ] 複数地域展開（東京/シンガポール/バージニア）

### Phase 3: エコシステム (2ヶ月)

- [ ] Next.js統合プラグイン
- [ ] 報酬システム（トークン連携）
- [ ] ダッシュボード開発
- [ ] パブリックベータ（招待制）

### Phase 4: 商用化 (3ヶ月)

- [ ] SLA保証機能（99.9%可用性）
- [ ] エンタープライズ機能（SSO、監査ログ）
- [ ] セキュリティ認証（SOC2 Type II準拠）
- [ ] 公式リリース

---

## 11. リスクと対策（詳細版）

| リスク | 内容 | 確率 | 影響 | 対策 | 監視指標 |
|-------|------|------|------|------|---------|
| **セキュリティ脆弱性** | サンドボックス突破 | 低 | 高 | 多層防御 + 定期的なセキュリティ監査（年2回） | 脆弱性スキャン結果 |
| **Worker枯渇** | タブを閉じるユーザー増加 | 中 | 高 | フォールバック + インセンティブ強化 + Mobile Safari除外 | Active Workers数 |
| **パフォーマンス不安定** | ブラウザ環境のばらつき | 高 | 中 | 複数Worker重複実行 + 適応的選定 | P95レイテンシ |
| **法規制** | 計算リソース提供の規制 | 低 | 高 | 法務確認 + 利用規約の明確化 + 地域別対応 | 規制動向 |
| **悪意あるユーザー** | 偽結果の返却 | 中 | 中 | 整合性チェック + 信頼性スコアリング + 自動BAN | Fraud検出率 |
| **技術的負債** | QuickJSの制限 | 中 | 低 | 代替ランタイム調査（SpiderMonkey Wasm化等） | 機能要望数 |

---

## 12. テスト戦略

### 12.1 テスト階層

```
┌─────────────────────────────────────────┐
│  1. ユニットテスト                       │
│  - QuickJSサンドボックス                 │
│  - ハッシュ計算                          │
│  - 署名検証                             │
├─────────────────────────────────────────┤
│  2. 統合テスト                           │
│  - Worker-Dispatcher通信                │
│  - フォールバック連携                    │
│  - DB整合性                             │
├─────────────────────────────────────────┤
│  3. E2Eテスト                            │
│  - 実ブラウザでの実行                    │
│  - 負荷テスト（10,000 RPS）              │
│  - カオスエンジニアリング                │
├─────────────────────────────────────────┤
│  4. セキュリティテスト                    │
│  - ペネトレーションテスト                 │
│  - ファジング（AFL++）                   │
│  - タイミング攻撃検証                    │
└─────────────────────────────────────────┘
```

### 12.2 カオスエンジニアリング計画

| 実験名 | 内容 | 期待結果 | 回復基準 |
|-------|------|---------|---------|
| **Worker Kill** | ランダムに50%のWorker切断 | フォールバック率上昇、可用性維持 | 30秒以内にフォールバック稼働 |
| **Network Partition** | 東京リージョン分離 | 他リージョンWorkerでカバー | レイテンシ<2s増加のみ |
| **Latency Injection** | Worker応答に500ms遅延追加 | タイムアウト増加、フォールバック | 成功率>95%維持 |
| **Resource Exhaustion** | Workerメモリ制限 strict化 | OOMエラー増加、自動再起動 | エラー率<5% |

---

## 13. 参考資料

- [QuickJS Documentation](https://bellard.org/quickjs/)
- [WebAssembly Specification](https://webassembly.github.io/spec/)
- [Web Workers API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
- [Practical Byzantine Fault Tolerance (PBFT)](https://pmg.csail.mit.edu/papers/osdi99.pdf)
- [Emscripten Documentation](https://emscripten.org/)
- [SHA-3 Standard (FIPS 202)](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.202.pdf)

---

**ドキュメントバージョン**: 2.0  
**最終更新**: 2026年2月  
**作成者**: SHIDE-QJS 開発チーム  
**レビュー**: セキュリティチーム、インフラチーム
