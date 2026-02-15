/// Fibonacci benchmark for MoonBit wasm-gc PoC
///
/// Implements naive recursive fibonacci for performance comparison
/// against QuickJS Wasm and native V8 JavaScript.
///
/// Why naive recursive? Deliberately unoptimized to measure raw
/// computation speed. fibonacci(40) produces ~2^40 recursive calls,
/// making it a reliable CPU-bound benchmark that exercises function
/// call overhead and stack management.
///
/// Expected results (vendor benchmarks, not independently verified):
///   - MoonBit wasm-gc: ~177ms for fib(46) (close to Rust's ~160ms)
///   - Native V8 JIT:   ~800ms for fib(40)
///   - QuickJS Wasm:    too slow for fib(40) (interpreter overhead)
///
/// Exported via wasm-gc for browser consumption.
/// The 'fibonacci' function is listed in moon.pkg.json exports
/// so it becomes a WebAssembly export callable from JavaScript.

/// Naive recursive fibonacci.
/// Time complexity: O(2^n) - intentionally unoptimized for benchmarking.
/// fib(40) = 102334155
pub fn fibonacci(n : Int) -> Int {
  if n <= 1 {
    n
  } else {
    fibonacci(n - 1) + fibonacci(n - 2)
  }
}

/// Entry point for standalone execution (moon run).
/// Prints fibonacci(40) result to verify correctness.
fn main {
  let result = fibonacci(40)
  println("fibonacci(40) = \{result}")
}
