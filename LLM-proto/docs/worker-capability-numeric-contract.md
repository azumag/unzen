# Worker capability numeric contract

Tracking: #449. Parent technical-core work: #167.

## Trust boundary

`WorkerCapability` is worker-supplied data consumed by Coordinator-side validation and routing decisions. Integer-valued capacity fields must therefore preserve exact integer identity in JavaScript.

The following fields are admitted only as JavaScript safe integers:

```text
contextWindowTokens:         Number.isSafeInteger(value) && value > 0
currentContextUsageTokens:   Number.isSafeInteger(value) && value >= 0   // when present
maxConcurrency:              Number.isSafeInteger(value) && value > 0
```

Values above `Number.MAX_SAFE_INTEGER` are rejected even if `Number.isInteger()` would report `true`, because distinct mathematical counts can collapse to the same JavaScript `number` at that magnitude.

The `currentContextUsageTokens <= contextWindowTokens` consistency comparison is performed only after both values have passed the safe-integer domain check. Invalid fields therefore fail on their own trust-boundary issue rather than participating in routing-facing capacity arithmetic.

## Compatibility

This is validation hardening for malformed or non-representable capability advertisements. It does not change the capability schema or protocol version, nor the behavior of existing valid capabilities. It also does not provide evidence for real-browser/WebGPU execution or distributed recovery; those remain separate #167 concerns.
