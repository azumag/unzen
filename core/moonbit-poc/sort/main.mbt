/// Sort benchmark for MoonBit wasm-gc PoC
///
/// Implements quicksort for sorting 10,000 pseudo-random integers.
/// Used for performance comparison against QuickJS Wasm and native V8 JS.
///
/// This benchmark tests:
///   - Array allocation and random access
///   - Recursive function calls (quicksort partition)
///   - Mutable state management
///   - Memory management via wasm-gc (GC delegated to browser VM)
///
/// The pseudo-random number generator (LCG) uses fixed seed=42
/// for deterministic, reproducible results across all runtimes.

/// Linear Congruential Generator (LCG) for deterministic pseudo-random numbers.
/// Uses standard glibc LCG parameters:
///   - multiplier: 1103515245
///   - increment:  12345
///   - modulus:    2^31 (achieved via bitwise AND with 0x7FFFFFFF)
/// Fixed seed ensures identical sequences across JS, QuickJS, and MoonBit.
fn lcg_next(seed : Int) -> Int {
  // Bitwise AND with 0x7FFFFFFF to keep result in positive 31-bit range.
  // Assumes wasm32 wrapping arithmetic for intermediate multiplication.
  (seed * 1103515245 + 12345) & 0x7FFFFFFF
}

/// Generate an array of pseudo-random integers for sorting benchmark.
/// Uses LCG with seed=42 for reproducibility.
/// Values are modulo 100000 to keep numbers in a reasonable range.
pub fn generate_random_array(size : Int) -> Array[Int] {
  let arr = Array::make(size, 0)
  let mut seed = 42
  for i = 0; i < size; i = i + 1 {
    seed = lcg_next(seed)
    arr[i] = seed % 100000
  }
  arr
}

/// Swaps two elements in an array by index.
/// Extracted as a helper to reduce duplication in partition logic.
fn swap(arr : Array[Int], i : Int, j : Int) -> Unit {
  let temp = arr[i]
  arr[i] = arr[j]
  arr[j] = temp
}

/// In-place quicksort using Lomuto partition scheme.
/// Chosen for simplicity and consistency with the JS benchmark implementation.
/// Time complexity: O(n log n) average, O(n^2) worst case.
fn quicksort(arr : Array[Int], low : Int, high : Int) -> Unit {
  if low < high {
    let pivot_idx = partition(arr, low, high)
    quicksort(arr, low, pivot_idx - 1)
    quicksort(arr, pivot_idx + 1, high)
  }
}

/// Lomuto partition: selects arr[high] as pivot,
/// partitions elements into <= pivot and > pivot groups.
/// Returns the final position of the pivot element.
fn partition(arr : Array[Int], low : Int, high : Int) -> Int {
  let pivot = arr[high]
  let mut i = low - 1
  for j = low; j < high; j = j + 1 {
    if arr[j] <= pivot {
      i = i + 1
      swap(arr, i, j)
    }
  }
  // Place pivot in its correct position
  swap(arr, i + 1, high)
  i + 1
}

/// Sort benchmark entry point.
/// Generates a pseudo-random array of the given size, sorts it,
/// and returns the first element as a verification value.
/// The first element of the sorted array should be deterministic
/// given the fixed LCG seed.
pub fn sort_benchmark(size : Int) -> Int {
  let arr = generate_random_array(size)
  quicksort(arr, 0, arr.length() - 1)
  // Return first element as a simple correctness check.
  // With seed=42 and size=10000, this value should be consistent.
  arr[0]
}

/// Entry point for standalone execution (moon run).
fn main {
  let result = sort_benchmark(10000)
  println("sort(10000) first element = \{result}")
}
