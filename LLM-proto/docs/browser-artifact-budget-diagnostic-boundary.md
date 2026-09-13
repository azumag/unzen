# Browser artifact-budget diagnostic boundary

The real browser split harness treats artifact byte declarations and budget mode as runtime input. Rejection diagnostics must not call user-defined string coercion on malformed values, because a throwing `toString` or `Symbol.toPrimitive` hook would replace the intended budget-contract failure with an incidental JavaScript exception.

`artifact-budget.js` therefore renders primitives explicitly and describes objects/functions structurally for diagnostics. Segment indexes used only for error labels go through the same path. Valid P0 (256 MiB preferred maximum) and absolute (1 GiB) budget calculations are unchanged.

This is reliability hardening for Issue #632 / #167. It does not provide new real-model artifact-size, physical WebGPU memory, multi-browser relay/latency, or worker-loss evidence.
