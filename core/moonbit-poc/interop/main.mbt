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
fn main { println("interop built") }
