# SpanRouter feasible-route search contract

`SpanRouter` ranks idle workers by artifact locality first and then by tier / span capacity / VRAM. That ranking is a preference order, not a proof that the first candidate can participate in a complete route.

With byte-budgeted model splitting, segment VRAM requirements can be unequal. A worker that is attractive at the current boundary may also be the only worker capable of a later larger segment. A purely greedy choice can therefore strand the suffix and incorrectly return `null` even though another ordering is feasible.

The router now explores ranked candidates in order and backtracks only when a choice cannot cover the remaining suffix. Failed `(segment boundary, used worker set)` states are memoized so equivalent dead ends are not searched repeatedly. A worker is still assigned at most one contiguous span per route, and when the highest-ranked path is feasible the deterministic route remains unchanged.

This is a coordinator-side routing correctness guarantee. It does not prove WebGPU execution, artifact download success, or runtime memory residency on a real browser worker; those remain separate evidence requirements under #167.
