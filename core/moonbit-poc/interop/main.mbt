pub fn echo(s : String) -> String { s }
pub fn join_words(a : String, b : String) -> String { a + b }
pub fn string_len(s : String) -> Int { s.length() }
pub fn make_string() -> String { "hello" }
pub fn weird_string() -> String { "__proto__" }
pub fn empty_string() -> String { "" }
pub fn unicode_string() -> String { "こんにちは" }
pub fn sum_array(arr : Array[Int]) -> Int {
  let mut total = 0
  for i = 0; i < arr.length(); i = i + 1 { total = total + arr[i] }
  total
}
pub fn make_array() -> Array[Int] { [1, 2, 3] }
pub fn reverse_array(arr : Array[Int]) -> Array[Int] {
  let n = arr.length()
  let out = Array::make(n, 0)
  for i = 0; i < n; i = i + 1 { out[n - 1 - i] = arr[i] }
  out
}
pub fn sum_double_array(arr : Array[Double]) -> Double {
  let mut total = 0.0
  for i = 0; i < arr.length(); i = i + 1 { total = total + arr[i] }
  total
}
pub fn scale_double_array(arr : Array[Double], factor : Double) -> Array[Double] {
  let out = Array::make(arr.length(), 0.0)
  for i = 0; i < arr.length(); i = i + 1 { out[i] = arr[i] * factor }
  out
}

// Standard unzen copy bridge. JS never constructs wasm-gc arrays directly;
// the executor allocates an opaque handle, fills it, calls the target export,
// then copies array results back through length/get.
pub fn unzen_array_i32_new(length : Int) -> Array[Int] { Array::make(length, 0) }
pub fn unzen_array_i32_set(arr : Array[Int], index : Int, value : Int) -> Unit {
  arr[index] = value
}
pub fn unzen_array_i32_length(arr : Array[Int]) -> Int { arr.length() }
pub fn unzen_array_i32_get(arr : Array[Int], index : Int) -> Int { arr[index] }

pub fn unzen_array_f64_new(length : Int) -> Array[Double] { Array::make(length, 0.0) }
pub fn unzen_array_f64_set(
  arr : Array[Double],
  index : Int,
  value : Double,
) -> Unit {
  arr[index] = value
}
pub fn unzen_array_f64_length(arr : Array[Double]) -> Int { arr.length() }
pub fn unzen_array_f64_get(arr : Array[Double], index : Int) -> Double { arr[index] }
fn main { println("interop built") }
