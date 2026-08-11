/// Infinite-loop / bounded-hang MoonBit modules for worker-termination tests.
///
/// These exports are deliberately CPU-bound and uninterruptible inside the
/// worker (the same is true of any long-running MoonBit export). The dedicated
/// MoonBit worker enforces timeouts/cancellation by terminating the worker,
/// which is exactly what these modules exercise:
///
/// - `hang_forever`: never returns; the main thread must force-terminate the
///   worker (hard timeout / cancel).
/// - `bounded_hang(n)`: spins for roughly n * 100ms then returns 1. Useful to
///   prove a normal long-running call still completes when it fits the timeout.

/// Never returns. Used to verify Worker.terminate() enforcement.
pub fn hang_forever() -> Int {
  let mut i : Int = 0
  while true {
    i = i + 1
  }
  i
}

/// Spins for approximately n * 100ms then returns 1.
pub fn bounded_hang(n : Int) -> Int {
  let mut i : Int = 0
  let target : Int = n * 100_000_000
  while i < target {
    i = i + 1
  }
  1
}

fn main {
  println("hang module built")
}
