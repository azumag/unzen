# Multi-segment planner byte-count contract

The browser-artifact partition planner treats layer counts, hidden size, and byte budgets as discrete counts rather than generic Python numerics.

`plan_layer_spans()` requires `hidden_size`, `target_bytes`, and `required_max_bytes` to be positive Python `int` values and rejects `bool`. It performs that validation, including `target_bytes <= required_max_bytes`, before inspecting the model or estimating any segment. `_select_partition()` independently requires exact positive integers for `total_layers`, `target_bytes`, and `required_max_bytes` before invoking its `span_cost` callback.

The browser-budget diagnostic applies the same preflight discipline at `diagnose_model()`: `hidden_size` and `target_bytes` must be positive Python `int` values, while `top_initializers` must be a non-negative Python `int`; `bool`, floats, `NaN`, and infinities are rejected. All three controls are validated before the source graph is opened or parsed and before span-cost evaluation, while `top_initializers=0` remains a valid request for an empty diagnostic initializer shortlist.

A span-cost callback must return an exact non-negative Python `int`. Zero is valid; `bool`, floats, non-finite values, strings, and negative integers are rejected instead of being coerced. This keeps byte estimates and deterministic partition ordering in the integer domain and prevents malformed budgets from triggering unnecessary graph extraction.

These checks do not change the partition objectives: the planner still minimizes segment count first, then maximum segment bytes, target-distance, and finally lexicographic cut order. `BrowserArtifactBudgetError` remains the fail-close result when valid integer costs cannot satisfy the required maximum.
