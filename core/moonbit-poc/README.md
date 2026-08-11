# MoonBit wasm-gc Proof of Concept

> **Status**: PoC complete. Build verified with MoonBit CLI v0.1.20260126. fibonacci.wasm: 8.2KB, sort.wasm: 9.0KB. Browser benchmark verified (2026-08-11).

## Browser benchmark results (2026-08-11)

実ブラウザ (Chrome) で Native JS と MoonBit wasm-gc の比較を実行した。

**環境**: Chrome 151.0.7922.76 / macOS 26.6.1 / Mac mini (Apple M4, 16GB) /
MoonBit CLI v0.1.20260126 / 10 iterations + 1 warm-up、P50 (中央値) を採用。

| Benchmark | Native JS | MoonBit wasm-gc | Speedup |
|---|---|---|---|
| fibonacci(40) | 595.00 ms | 187.60 ms | **3.17x** |
| sort(10,000) | 0.60 ms | 0.50 ms | 1.20x |

### 所見

- 再帰・純粋計算主体の fibonacci では wasm-gc が Native JS を約 3.2 倍上回る。
  QuickJS Wasm インタプリタの想定遅延 (~35-55x vs V8) と比較すると、
  計算密集型ワークロードでは wasm-gc が明確に有利。
- 配列操作主体の sort ではほぼ同等 (1.20x)。wasm-gc の配列アクセスは
  JS に対して大きな劣位がなく、QuickJS で 0.5-1.4s かかる想定の
  10K 要素ソートが実質数 ms で完了する。
- ブラウザは wasm-gc 対応 (Chrome 119+/Firefox 120+/Safari 18.2+) が必要。
  `benchmark/index.html` は非対応ブラウザでも Native JS のみ実行する。
- sort の LCG は JS 側で `Math.imul` を使用し、MoonBit の i32 wrapping と
  同一系列になるようにしている (固定系列の先頭要素は両 runtime とも 9 で一致)。
  plain JS 乗算は safe-integer を超え、系列がずれて比較が無効になる。

### Cross-browser 検証 (2026-08-11)

MoonBit 専用 Worker (`MoonBitWorkerSandboxExecutor`) を Chromium 145.0.7632.6
(Playwright) と Firefox 146.0.1 (Playwright) の両方で実ブラウザ検証した:

| 検証 | Chromium 145 | Firefox 146 |
|---|---|---|
| fibonacci wasm 実行 (worker) | fib(10)=55, fib(15)=610 | 同左 |
| 無限ループの hard timeout | DEADLINE_EXCEEDED (Worker terminate) | 同左 |
| 無限ループの cancel | CANCELLED (Worker terminate) | 同左 |
| terminate 後の recovery | 次実行が新 generation で成功 | 同左 |
| メインスレッド応答性 | hang 中も interval tick 継続 | 同左 |

注: Firefox の wasm 実行は Chrome より遅く、`bounded_hang` のループは
Chrome の約 1.5-3 倍の時間がかかる。強制終了テストの timeout は
Firefox でも確実に完了する値 (800ms budget / 1200ms hard kill) に設定している。

### 再現手順

```bash
cd moonbit-poc
moon build --target wasm-gc   # fibonacci.wasm / sort.wasm を生成
python3 -m http.server 8080 --bind 127.0.0.1
# http://localhost:8080/benchmark/ を Chrome で開き "Run All" をクリック
```

## Purpose

This PoC evaluates **MoonBit wasm-gc** as a high-performance runtime for unzen core Phase 3.

Currently, unzen delegates computation to browsers via QuickJS Wasm (an interpreter running inside Wasm). While this works well for short functions (<50ms), computation-heavy tasks suffer from QuickJS's ~35-55x slowdown compared to V8 JIT.

MoonBit compiles directly to **wasm-gc** (WebAssembly with Garbage Collection), potentially achieving near-native performance by:
- Compiling MoonBit source to optimized Wasm bytecode (no interpreter overhead)
- Delegating garbage collection to the browser's VM (no GC runtime in binary)
- Producing ultra-small binaries (fib function: ~253 bytes, HTTP component: ~27KB)

### What this PoC validates

1. **Build feasibility**: Can we build MoonBit packages targeting wasm-gc?
2. **Binary size**: How small are the generated .wasm files?
3. **Performance**: How does MoonBit wasm-gc compare to native V8 JS?
4. **Browser loading**: Can we load and call wasm-gc exports from JavaScript?
5. **Integration path**: What changes are needed in unzen's Client SDK?

## MoonBit wasm-gc Overview

[MoonBit](https://www.moonbitlang.com/) is a programming language designed for WebAssembly. Key characteristics:

- **wasm-gc backend**: GC is delegated to the browser VM (Chrome/Firefox/Safari), not bundled in binary
- **Ultra-small binaries**: Functions compile to hundreds of bytes, not megabytes
- **Near-native performance**: Vendor benchmarks show fib(46) at 177ms vs Rust's 160ms (not independently verified)
- **Type-safe**: Strong static typing with algebraic data types, pattern matching
- **Pure functions**: No side effects by default, ideal for sandboxed execution

### Comparison with QuickJS

| Aspect | QuickJS Wasm | MoonBit wasm-gc |
|--------|-------------|-----------------|
| Execution | Interprets JS inside Wasm | Compiles to native Wasm |
| Performance | ~35-55x slower than V8 JIT | Near-native (vendor claim) |
| Binary size | ~150KB gzip (runtime) + code | ~253B to ~27KB per function |
| Language | JavaScript (existing code) | MoonBit (new language) |
| Browser support | All Wasm browsers (~95%) | wasm-gc browsers (~85%+) |
| GC | Built into QuickJS runtime | Delegated to browser VM |

## Prerequisites

### Install MoonBit CLI

```bash
# Option 1: Shell script (recommended)
curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash

# Option 2: VS Code extension
# Install "MoonBit" extension, then run:
# Shift+Cmd+P -> "MoonBit: install latest moonbit toolchain"

# Option 3: Wasm toolchain (for older Intel Macs, requires Node.js 24+)
curl -fsSL https://raw.githubusercontent.com/moonbitlang/moonbit-compiler/refs/heads/main/install.ts | node
```

After installation, verify:

```bash
moon version
# Expected: moon <version>
```

## Build Instructions

```bash
# From the moonbit-poc directory:
cd moonbit-poc

# Build all packages for wasm-gc target
moon build --target wasm-gc

# Build output locations:
# target/wasm-gc/release/build/fibonacci/fibonacci.wasm
# target/wasm-gc/release/build/sort/sort.wasm

# Run standalone (prints to terminal):
moon run fibonacci
# Output: fibonacci(40) = 102334155

moon run sort
# Output: sort(10000) first element = <deterministic value>
```

### Check binary sizes

```bash
# After building:
ls -la target/wasm-gc/release/build/fibonacci/fibonacci.wasm
ls -la target/wasm-gc/release/build/sort/sort.wasm

# Expected: fibonacci.wasm should be very small (< 1KB)
# Expected: sort.wasm should be small (< 10KB)
```

## Running Benchmarks in Browser

### 1. Build MoonBit wasm files

```bash
moon build --target wasm-gc
```

### 2. Serve with a local HTTP server

```bash
# From the moonbit-poc directory:
# Python:
python3 -m http.server 8080

# Or Node.js (npx):
npx serve .

# Or any static file server
```

### 3. Open the benchmark page

Navigate to `http://localhost:8080/benchmark/` in a wasm-gc capable browser.

The page will:
- Auto-detect wasm-gc support
- Allow running fibonacci and sort benchmarks
- Display Native JS vs MoonBit wasm-gc comparison

### Native JS benchmarks work without MoonBit build

Even without building the MoonBit packages, the benchmark page will run Native JS benchmarks. MoonBit columns will show "N/A" until .wasm files are available.

## Browser Compatibility

wasm-gc is required to run MoonBit compiled modules:

| Browser | Version | Release Date | Status |
|---------|---------|-------------|--------|
| Chrome | 119+ | Nov 2023 | Supported |
| Firefox | 120+ | Nov 2023 | Supported |
| Safari | 18.2+ (wasm-gc) / 26.2+ (JS String Builtins) | Dec 2024 / Dec 2025 | wasm-gc supported; String interop unverified in this repo |
| Edge | 119+ | Nov 2023 | Supported |
| Samsung Internet | 25+ | 2024 | Supported |

As of early 2026, wasm-gc is supported by ~85%+ of global browser traffic (all evergreen browsers).

### JS String Builtins

MoonBit's `use-js-builtin-string: true` option (used in the `interop` package)
enables efficient string interop via the JS String Builtins proposal. The
`interop` package also sets `imported-string-constants: "_"`, so each string
literal becomes an import in the `_` module whose name is the literal itself.
The client compiles with `await WebAssembly.compile(bytes, { builtins:
['js-string'], importedStringConstants: '_' })`, which resolves the
`wasm:js-string` builtins and the `_` string-constant imports at compile time;
instantiation needs only the `spectest.print_char` / `console.log` runtime
imports. (A manual `_` import map is NOT used: building `{ name: name }`
objects would trip the `Object.prototype` setter for literals like
`"__proto__"`.) Verified on Chromium 145, Firefox 146, and Node 24
(2026-08-11): `string_len("hello") = 5`, `make_string() = "hello"`, `echo`
round-trip, `join_words("foo","bar") = "foobar"`, and `weird_string() =
"__proto__"` / empty / Unicode literals.

**Browser requirements**: String interop additionally requires the JS String
Builtins (Chromium / Firefox / Node 24 verified 2026-08-11). Safari supports
wasm-gc since 18.2 but JS String Builtins only since 26.2; String
arguments/results on Safari 18.2–26.1 are unavailable and unverified in this
repo (compile options do not apply there, leaving `_`/`wasm:js-string`
imports unresolved at instantiation). `importedStringConstants: '_'` reserves
the `_` namespace for string constants, so a module with other `_` imports
(e.g. functions) cannot be compiled by these executors.

### String / Array interop measurements (2026-08-11)

`moonbit-poc/interop` (compiled with `moon 0.1.20260126` for `wasm-gc`):

| Boundary | Result | Evidence |
|----------|--------|----------|
| `string` input | PASS | `string_len("hello") = 5` |
| `string` output | PASS | `make_string() = "hello"` |
| `string` round-trip | PASS | `echo("hello") = "hello"` |
| `string` join | PASS | `join_words("foo","bar") = "foobar"` |
| `string` special literals | PASS | `weird_string() = "__proto__"`, 空文字, Unicode (2026-08-11) |
| `Array[Int]` input (plain JS array) | REJECTED | `type incompatibility when transforming from/to JS` |
| `Array[Int]` output | OPAQUE | opaque wasm-gc handle; no `.length` / index access |
| `Array[Int]` handle re-input | PASS | `sum_array(make_array()) = 6` (opaque handle round-trip) |

Plain JS arrays cannot cross the export boundary; wasm-gc arrays only return
as opaque handles that can be passed back into MoonBit exports. A copy/glue
layer for arrays is a design task, not a toolchain block. Numeric exports
accept strings via WebAssembly's implicit ToNumber conversion
(`fibonacci("10") → 55`); the unzen executors validate scalars only, not
per-export ABI signatures.

## Benchmark Methodology

### Fibonacci(40)

- **Algorithm**: Naive recursive fibonacci, O(2^n)
- **Purpose**: Measures raw function call overhead and stack management
- **Expected result**: 102334155
- **Why recursive**: Exercises ~2^40 function calls, making it a pure CPU benchmark

### Sort(10,000)

- **Algorithm**: Quicksort with Lomuto partition
- **Purpose**: Measures array allocation, random access, and recursive partitioning
- **Input**: 10,000 pseudo-random integers (deterministic LCG, seed=42)
- **Verification**: First element of sorted array (deterministic given fixed seed)

### Measurement

- 10 iterations per benchmark
- 1 warm-up run (excluded)
- P50 (median) reported for stable comparison
- `performance.now()` timing (microsecond precision)

## Expected Performance Characteristics

Based on vendor benchmarks and community reports (not independently verified):

| Benchmark | Native V8 JS | MoonBit wasm-gc | Expected Speedup |
|-----------|-------------|-----------------|-----------------|
| fibonacci(40) | ~700-900ms | ~150-250ms | ~3-5x faster |
| sort(10000) | ~2-5ms | ~1-3ms | ~1.5-2x faster |

**Important caveats**:
- MoonBit vendor benchmarks show fib(46) at 177ms vs Rust's 160ms, but these are not independently verified
- V8 JIT is highly optimized for recursive code; the gap may be smaller than expected
- sort(10000) is a small workload where JIT warm-up dominates; larger arrays would show bigger differences
- Real-world performance depends on data marshaling overhead (JS-to-Wasm and back)

## Integration Considerations for Phase 4

### What needs to change in unzen

1. **Client SDK**: Add `MoonBitWasmExecutor` alongside existing `WebWorkerSandboxExecutor`
2. **Manifest**: Extend `ManifestEntry` with `runtime: "moonbit"` and `wasmUrl` field
3. **Server SDK**: Add `defineMoonBit()` and `defineMoonBitModule()` APIs
4. **Data marshaling**: Implement JS-to-MoonBit type conversion layer
5. **Feature detection**: Detect wasm-gc support, fallback to QuickJS or server

### Data marshaling challenges

MoonBit wasm-gc uses different memory representations than JavaScript:

| JS Type | MoonBit Type | Marshaling |
|---------|-------------|------------|
| `number` (int) | `Int` | Direct i32 (no marshaling needed) |
| `number` (float) | `Double` | Direct f64 (no marshaling needed) |
| `boolean` | `Bool` | i32 0/1 (trivial) |
| `string` | `String` | JS String Builtins (`use-js-builtin-string` + `builtins: ['js-string']`) — PASS (2026-08-11 実測) |
| `number[]` | `Array[Int]` | plain JS 配列は境界で拒否。opaque handle の再入力のみ可 (2026-08-11 実測) |
| `object` | - | JSON serialize/deserialize (slow) |

Primitive types (Int, Double, Bool) have zero marshaling cost. Arrays and objects require copying, which may offset MoonBit's speed advantage for small payloads.

### Security model

MoonBit wasm-gc modules run inside the same Wasm sandbox as QuickJS:
- **Memory isolation**: wasm-gc modules have their own managed memory
- **No external access**: Wasm cannot make network requests or access DOM
- **Import restriction**: Only explicitly provided imports are available

> **注 (2026-08-11)**: `MoonBitWorkerSandboxExecutor`（`moonbitWorkerUrl` 指定時）
> は専用 Web Worker で wasm を実行し、メインスレッドをブロックしない。
> タイムアウト/キャンセルは `Worker.terminate()` で強制する。Worker 内の export
> 自体は同期・中断不可。`MoonBitSandboxExecutor`（Worker なし）はデモ用途。

## Go/No-Go Criteria

This PoC should inform the decision to proceed with MoonBit integration.

### Go (proceed to Phase 4) if:

- [ ] MoonBit wasm-gc builds produce binaries under 50KB for both benchmarks
- [ ] fibonacci(40) runs at least 2x faster than native V8 JS
- [ ] sort(10000) runs at least 1.5x faster than native V8 JS
- [ ] .wasm files load and execute correctly in Chrome, Firefox, and Safari
- [ ] Data marshaling for primitive types (Int, Double) works without glue code
- [ ] MoonBit language syntax is approachable for the target audience

### No-Go (defer or abandon) if:

- [ ] Binary sizes exceed 100KB for simple functions
- [ ] Performance is slower than or equal to native V8 JS
- [ ] wasm-gc browser support is below 80% of target audience
- [ ] Data marshaling overhead negates performance gains
- [ ] MoonBit tooling is too unstable for production use

### Defer (revisit later) if:

- [ ] Performance gains are marginal (< 1.5x) but binary sizes are excellent
- [x] ~~JS String Builtins support is too limited (Chrome-only)~~ — 解決:
  Chromium 145 / Firefox 146 で String 引数・戻り値の往復を確認 (2026-08-11)
- [ ] MoonBit language is pre-1.0 and API stability is a concern

## Directory Structure

```
moonbit-poc/
├── README.md              # This file
├── moon.mod.json          # MoonBit module configuration
├── fibonacci/
│   ├── main.mbt           # Naive recursive fibonacci implementation
│   └── moon.pkg.json      # Package config (exports fibonacci)
├── sort/
│   ├── main.mbt           # Quicksort with LCG random array generation
│   └── moon.pkg.json      # Package config (exports sort_benchmark)
└── benchmark/
    ├── index.html          # Benchmark UI (works without MoonBit build)
    └── benchmark.js        # Benchmark runner (Native JS + MoonBit wasm-gc)
```

## Current Findings

### Build Status: SUCCESS

MoonBit CLI v0.1.20260126 installed and both packages build successfully.

```
$ moon version
moon 0.1.20260126 (9434410 2026-01-26)

$ moon build --target wasm-gc
Finished. moon: ran 4 tasks, now up to date
```

### Binary Sizes (PASS - under 50KB threshold)

| Package | Raw Size | Gzipped Size |
|---------|----------|-------------|
| fibonacci.wasm | 8,420 bytes (8.2 KB) | 3,845 bytes (3.8 KB) |
| sort.wasm | 9,055 bytes (8.8 KB) | ~4.0 KB |

For comparison, QuickJS Wasm runtime is ~505 KB uncompressed (~150 KB gzipped).
MoonBit function binaries are **55-60x smaller** than the QuickJS runtime.

### Correctness Verification (PASS)

```
$ moon run fibonacci
fibonacci(40) = 102334155

$ moon run sort
sort(10000) first element = 9
```

Both programs produce correct, deterministic results.

### Wasm Module Structure

Compiled modules import from `spectest` namespace:
- `spectest.print_char` (used by `println` for character output)

Exports match `moon.pkg.json` configuration:
- fibonacci.wasm exports: `fibonacci`, `_start`
- sort.wasm exports: `sort_benchmark`, `generate_random_array`, `_start`

### Go/No-Go Preliminary Assessment

| Criterion | Status | Notes |
|-----------|--------|-------|
| Binary size < 50KB | PASS | 8.2 KB and 9.0 KB |
| Build succeeds | PASS | Clean build, 4 tasks |
| Correctness | PASS | Deterministic results verified |
| Performance vs V8 | PASS (Chrome) | fib 3.17x / sort 1.20x (2026-08-11 実測) |
| Browser loading | PASS (Chrome) | wasm-gc fetch + instantiate 成功 (2026-08-11 実測) |
| Data marshaling | PARTIAL | Int/Double/Bool は直接 i32/f64。String は JS String Builtins で往復可。Array は opaque handle のみ (2026-08-11 実測) |

### Next Steps

1. ~~Open benchmark in Chrome and record numbers~~ (完了: 2026-08-11, fib 3.17x / sort 1.20x)
2. Firefox / Safari での計測（cross-browser 未確認）
3. ~~Data marshaling (Array / String) の検証~~ — 完了 (2026-08-11)
   String は `use-js-builtin-string: true` + `imported-string-constants: "_"` +
   `await WebAssembly.compile(bytes, { builtins: ['js-string'],
   importedStringConstants: '_' })` で引数・戻り値とも JS 文字列として往復可
   （Chromium 145 / Firefox 146 で確認。`"__proto__"` / Unicode も含む）。
   Array[Int] は plain JS 配列の受け渡しが wasm 境界で
   `type incompatibility` になり、戻り値は opaque handle（別 export への
   再入力のみ可）。配列の glue 層実装は設計タスク。
4. sort は Go/No-Go 基準 1.5x に未達 (1.20x) のため、配列中心ワークロードでは
   QuickJS との比較を含めた再評価が必要
