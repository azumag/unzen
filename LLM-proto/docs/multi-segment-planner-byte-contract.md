# Multi-segment planner byte-count contract

The browser-artifact partition planner treats layer counts, hidden size, and byte budgets as discrete counts rather than generic Python numerics.

`plan_layer_spans()` requires `hidden_size`, `target_bytes`, and `required_max_bytes` to be positive Python `int` values and rejects `bool`. It performs that validation, including `target_bytes <= required_max_bytes`, before inspecting the model or estimating any segment. `_select_partition()` independently requires exact positive integers for `total_layers`, `target_bytes`, and `required_max_bytes` before invoking its `span_cost` callback.

A span-cost callback must return an exact non-negative Python `int`. Zero is valid; `bool`, floats, non-finite values, strings, and negative integers are rejected instead of being coerced. This keeps byte estimates and deterministic partition ordering in the integer domain and prevents malformed budgets from triggering unnecessary graph extraction.

These checks do not change the partition objectives: the planner still minimizes segment count first, then maximum segment bytes, target-distance, and finally lexicographic cut order. `BrowserArtifactBudgetError` remains the fail-close result when valid integer costs cannot satisfy the required maximum.
