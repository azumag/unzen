/**
 * MoonBit wasm-gc Benchmark Runner
 *
 * Compares performance of:
 * 1. Native JavaScript (V8 JIT / SpiderMonkey / JavaScriptCore)
 * 2. MoonBit wasm-gc (if .wasm files are available and browser supports wasm-gc)
 *
 * QuickJS comparison requires running the unzen demo server separately
 * and is not included in this standalone benchmark.
 *
 * Benchmark methodology:
 * - 10 iterations per test (configurable via ITERATIONS constant)
 * - 1 warm-up run excluded from measurements
 * - Reports P50 (median) for stable comparison
 * - Uses performance.now() for microsecond-precision timing
 * - Identical algorithms across all runtimes for fair comparison
 */

// =====================================================
// Configuration
// =====================================================

const ITERATIONS = 10;
const WARMUP_RUNS = 1;

// Paths to MoonBit wasm-gc build artifacts.
// After running `moon build --target wasm-gc`, copy the .wasm files here
// or update these paths to point to the build output directory.
const MOONBIT_WASM_PATHS = {
  fibonacci: '../target/wasm-gc/release/build/fibonacci/fibonacci.wasm',
  sort: '../target/wasm-gc/release/build/sort/sort.wasm',
};

// =====================================================
// wasm-gc Feature Detection
// =====================================================

/**
 * Detect whether the browser supports wasm-gc by attempting
 * to compile a minimal wasm-gc module.
 *
 * wasm-gc modules use GC types (struct, array) which are only
 * available in browsers that implement the GC proposal:
 * Chrome 119+, Firefox 120+, Safari 18+, Edge 119+.
 *
 * The test module defines an empty struct type `(module (type (struct)))`.
 * In the wasm binary type section, 0x5F encodes a struct composite type
 * (per the GC spec: https://webassembly.github.io/gc/core/binary/types.html).
 * Browsers without wasm-gc support will throw a CompileError.
 *
 * Note: 0x5F means "struct" only in the type section context.
 * In the instruction section it would mean f32.le, but type section
 * bytes are parsed differently by the wasm decoder.
 */
async function detectWasmGcSupport() {
  try {
    // Minimal wasm module: (module (type (struct)))
    // Defines an empty struct type (0 fields) using the GC proposal's
    // struct composite type encoding (0x5F).
    // This will throw CompileError on browsers without wasm-gc support.
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // magic: \0asm
      0x01, 0x00, 0x00, 0x00, // version: 1
      // Type section: 1 struct type with 0 fields
      0x01,       // section id: type section
      0x03,       // section length: 3 bytes
      0x01,       // 1 type entry
      0x5f,       // struct composite type (GC proposal)
      0x00,       // 0 fields (empty struct)
    ]);
    await WebAssembly.compile(bytes);
    return true;
  } catch (e) {
    // CompileError: browser does not support wasm-gc types
    return false;
  }
}

// =====================================================
// Native JS implementations (baseline)
// =====================================================

/**
 * Naive recursive fibonacci - O(2^n) time complexity.
 * Deliberately not optimized to measure raw computation speed.
 * fibonacci(40) = 102334155, producing ~2^40 recursive calls.
 */
function nativeFibonacci(n) {
  if (n <= 1) return n;
  return nativeFibonacci(n - 1) + nativeFibonacci(n - 2);
}

/**
 * Quicksort with Lomuto partition scheme.
 * Generates a deterministic pseudo-random array using the same LCG
 * parameters as the MoonBit implementation for identical input data.
 *
 * LCG parameters (glibc standard):
 *   multiplier: 1103515245
 *   increment:  12345
 *   modulus:    2^31 (via bitwise AND)
 *   seed:      42
 *
 * NOTE: the multiplication MUST use Math.imul so intermediate values wrap at
 * 32 bits exactly like the MoonBit Int (i32) implementation. Plain JS
 * multiplication exceeds the safe-integer range and produces a different
 * sequence, which would make the two runtimes sort different arrays.
 */
function nativeSort(size) {
  // Generate deterministic pseudo-random array (same LCG as MoonBit)
  const arr = new Array(size);
  let seed = 42;
  for (let i = 0; i < size; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7FFFFFFF;
    arr[i] = seed % 100000;
  }

  // Lomuto partition quicksort (matches MoonBit implementation)
  function quicksort(arr, low, high) {
    if (low < high) {
      const pivotIdx = partition(arr, low, high);
      quicksort(arr, low, pivotIdx - 1);
      quicksort(arr, pivotIdx + 1, high);
    }
  }

  function partition(arr, low, high) {
    const pivot = arr[high];
    let i = low - 1;
    for (let j = low; j < high; j++) {
      if (arr[j] <= pivot) {
        i++;
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    }
    [arr[i + 1], arr[high]] = [arr[high], arr[i + 1]];
    return i + 1;
  }

  quicksort(arr, 0, arr.length - 1);
  return arr[0]; // Return first element for verification
}

// =====================================================
// MoonBit Wasm Loader
// =====================================================

/**
 * Cache for loaded MoonBit wasm-gc module instances.
 * Each entry maps a benchmark name to its WebAssembly exports.
 */
const moonbitModules = {};

/**
 * Attempt to load a MoonBit wasm-gc module.
 * Returns the module's exports object, or null if loading fails.
 *
 * Loading can fail for several reasons:
 * - .wasm file not found (not built yet)
 * - Browser doesn't support wasm-gc
 * - Module validation error (wrong target/version)
 *
 * The function caches loaded modules to avoid re-instantiation.
 */
async function loadMoonbitModule(name) {
  if (moonbitModules[name] !== undefined) {
    return moonbitModules[name];
  }

  const path = MOONBIT_WASM_PATHS[name];
  if (!path) {
    moonbitModules[name] = null;
    return null;
  }

  try {
    const response = await fetch(path);
    if (!response.ok) {
      console.warn(
        `[moonbit] Failed to fetch ${path}: ${response.status} ${response.statusText}`
      );
      moonbitModules[name] = null;
      return null;
    }

    const buffer = await response.arrayBuffer();

    // MoonBit wasm-gc modules import from "spectest" namespace.
    // Verified: compiled modules import spectest.print_char for println.
    // The exact imports may vary by MoonBit compiler version.
    // When use-js-string-builtin is enabled, the browser engine
    // provides JS String Builtins imports automatically.
    const importObject = {
      spectest: {
        // print_char is imported by MoonBit for println support.
        // It receives a Unicode code point (i32) per character.
        print_char: (x) => {/* suppress output during benchmark */},
      },
    };

    const { instance } = await WebAssembly.instantiate(buffer, importObject);
    moonbitModules[name] = instance.exports;
    return instance.exports;
  } catch (e) {
    console.warn(`[moonbit] Failed to load ${name}: ${e.message}`);
    moonbitModules[name] = null;
    return null;
  }
}

// =====================================================
// Benchmark Runner
// =====================================================

/**
 * Run a function multiple times and collect timing data.
 *
 * Methodology:
 * - Runs `warmup` iterations first (excluded from results)
 * - Then runs ITERATIONS timed iterations
 * - Sorts times and returns percentiles (P50, P95, P99)
 *
 * @param {Function} fn - The function to benchmark (must be synchronous)
 * @param {number} warmup - Number of warm-up iterations (default: WARMUP_RUNS)
 * @returns {{ p50: number, p95: number, p99: number, min: number, max: number, times: number[] }}
 */
function benchmark(fn, warmup = WARMUP_RUNS) {
  // Warm-up runs: excluded from measurement.
  // Allows JIT compilation (V8) or Wasm compilation to complete.
  for (let i = 0; i < warmup; i++) {
    fn();
  }

  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    fn();
    const end = performance.now();
    times.push(end - start);
  }

  // Sort for percentile calculation
  times.sort((a, b) => a - b);
  return {
    p50: times[Math.floor(ITERATIONS * 0.5)],
    p95: times[Math.floor(ITERATIONS * 0.95)],
    p99: times[Math.floor(ITERATIONS * 0.99)],
    min: times[0],
    max: times[times.length - 1],
    times,
  };
}

// =====================================================
// UI Helpers
// =====================================================

function updateStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type; // '', 'error', or 'success'
}

function setButtonsDisabled(disabled) {
  document.getElementById('fibBtn').disabled = disabled;
  document.getElementById('sortBtn').disabled = disabled;
  document.getElementById('allBtn').disabled = disabled;
}

/**
 * Add a benchmark result row to the results table.
 *
 * @param {string} name - Benchmark name (e.g., "fibonacci(40)")
 * @param {number} nativeMs - Native JS P50 time in milliseconds
 * @param {number|null} moonbitMs - MoonBit wasm-gc P50 time, or null if unavailable
 */
function addResult(name, nativeMs, moonbitMs) {
  const tbody = document.getElementById('results');

  // Clear "no results" placeholder on first result
  if (
    tbody.children.length === 1 &&
    tbody.children[0].cells &&
    tbody.children[0].cells.length === 1
  ) {
    tbody.innerHTML = '';
  }

  const row = document.createElement('tr');

  // Benchmark name
  const nameCell = document.createElement('td');
  nameCell.textContent = name;
  nameCell.style.textAlign = 'left';
  row.appendChild(nameCell);

  // Native JS time
  const nativeCell = document.createElement('td');
  nativeCell.textContent = nativeMs.toFixed(2);
  row.appendChild(nativeCell);

  // MoonBit wasm-gc time
  const moonbitCell = document.createElement('td');
  if (moonbitMs !== null) {
    moonbitCell.textContent = moonbitMs.toFixed(2);
  } else {
    moonbitCell.textContent = 'N/A (build .wasm first)';
    moonbitCell.className = 'na';
  }
  row.appendChild(moonbitCell);

  // Speedup ratio
  const speedupCell = document.createElement('td');
  if (moonbitMs !== null && moonbitMs > 0) {
    const speedup = nativeMs / moonbitMs;
    speedupCell.textContent = speedup.toFixed(2) + 'x';
    // Color code: green if MoonBit is faster, red if slower
    if (speedup >= 1.0) {
      speedupCell.className = 'fastest';
    } else {
      speedupCell.className = 'slower';
    }
  } else {
    speedupCell.textContent = 'N/A';
    speedupCell.className = 'na';
  }
  row.appendChild(speedupCell);

  tbody.appendChild(row);
}

// =====================================================
// Benchmark Entry Points
// =====================================================

/**
 * Run the fibonacci(40) benchmark.
 * Compares native JS recursive fibonacci against MoonBit wasm-gc version.
 */
window.runFibBenchmark = async function () {
  setButtonsDisabled(true);
  updateStatus('Running fibonacci(40) benchmark...');

  // Small delay to allow UI update before CPU-intensive work
  await new Promise((r) => setTimeout(r, 50));

  try {
    // 1. Native JS benchmark
    const nativeResult = benchmark(() => nativeFibonacci(40));
    updateStatus(
      `Native JS fibonacci(40): ${nativeResult.p50.toFixed(2)}ms (P50). Loading MoonBit...`
    );

    // 2. MoonBit wasm-gc benchmark (if available)
    let moonbitP50 = null;
    const moonbitExports = await loadMoonbitModule('fibonacci');
    if (moonbitExports && moonbitExports.fibonacci) {
      // Allow a tick for the status update to render
      await new Promise((r) => setTimeout(r, 10));
      const moonbitResult = benchmark(() => moonbitExports.fibonacci(40));
      moonbitP50 = moonbitResult.p50;
    }

    addResult('fibonacci(40)', nativeResult.p50, moonbitP50);

    const msg = moonbitP50 !== null
      ? `Fibonacci complete. Native: ${nativeResult.p50.toFixed(2)}ms, MoonBit: ${moonbitP50.toFixed(2)}ms`
      : `Fibonacci complete. Native: ${nativeResult.p50.toFixed(2)}ms. MoonBit: not available (build .wasm first)`;
    updateStatus(msg, 'success');
  } catch (e) {
    updateStatus(`Error: ${e.message}`, 'error');
    console.error('[benchmark] fibonacci error:', e);
  }

  setButtonsDisabled(false);
};

/**
 * Run the sort(10000) benchmark.
 * Compares native JS quicksort against MoonBit wasm-gc version.
 */
window.runSortBenchmark = async function () {
  setButtonsDisabled(true);
  updateStatus('Running sort(10,000) benchmark...');

  await new Promise((r) => setTimeout(r, 50));

  try {
    // 1. Native JS benchmark
    const nativeResult = benchmark(() => nativeSort(10000));
    updateStatus(
      `Native JS sort(10000): ${nativeResult.p50.toFixed(2)}ms (P50). Loading MoonBit...`
    );

    // 2. MoonBit wasm-gc benchmark (if available)
    let moonbitP50 = null;
    const moonbitExports = await loadMoonbitModule('sort');
    if (moonbitExports && moonbitExports.sort_benchmark) {
      await new Promise((r) => setTimeout(r, 10));
      const moonbitResult = benchmark(() => moonbitExports.sort_benchmark(10000));
      moonbitP50 = moonbitResult.p50;
    }

    addResult('sort(10,000)', nativeResult.p50, moonbitP50);

    const msg = moonbitP50 !== null
      ? `Sort complete. Native: ${nativeResult.p50.toFixed(2)}ms, MoonBit: ${moonbitP50.toFixed(2)}ms`
      : `Sort complete. Native: ${nativeResult.p50.toFixed(2)}ms. MoonBit: not available (build .wasm first)`;
    updateStatus(msg, 'success');
  } catch (e) {
    updateStatus(`Error: ${e.message}`, 'error');
    console.error('[benchmark] sort error:', e);
  }

  setButtonsDisabled(false);
};

/**
 * Run all benchmarks sequentially.
 */
window.runAllBenchmarks = async function () {
  await window.runFibBenchmark();
  await window.runSortBenchmark();
  updateStatus('All benchmarks complete!', 'success');
};

// =====================================================
// Initialization
// =====================================================

/**
 * On page load: detect wasm-gc support and display status.
 */
(async function init() {
  const supportEl = document.getElementById('wasm-gc-support');
  const hasWasmGc = await detectWasmGcSupport();

  if (hasWasmGc) {
    supportEl.className = 'supported';
    supportEl.innerHTML =
      '<strong>wasm-gc: Supported</strong> - ' +
      'Your browser supports WebAssembly GC. MoonBit benchmarks will run if .wasm files are available.';
  } else {
    supportEl.className = 'unsupported';
    supportEl.innerHTML =
      '<strong>wasm-gc: Not Supported</strong> - ' +
      'Your browser does not support WebAssembly GC. MoonBit benchmarks will show as N/A. ' +
      'Requires Chrome 119+, Firefox 120+, Safari 18+, or Edge 119+.';
  }

  // Pre-check if .wasm files exist (non-blocking)
  for (const [name, path] of Object.entries(MOONBIT_WASM_PATHS)) {
    try {
      const resp = await fetch(path, { method: 'HEAD' });
      if (resp.ok) {
        console.log(`[moonbit] ${name}.wasm found at ${path}`);
      } else {
        console.log(
          `[moonbit] ${name}.wasm not found at ${path} (${resp.status}). ` +
          'Build with: moon build --target wasm-gc'
        );
      }
    } catch (e) {
      console.log(`[moonbit] Could not check ${name}.wasm: ${e.message}`);
    }
  }
})();
