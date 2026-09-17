# Direct verifier token runtime boundary

The direct multi-segment numerical verifiers accept token IDs from both CLI plumbing and programmatic callers. Runtime token inputs are therefore treated as caller-owned data until the shared preflight in `tools/direct_verifier_runtime.py` has detached and validated them.

## Snapshot contract

`preflight_direct_verifier_parameters()` snapshots the supplied token iterable exactly once before checking emptiness or validating individual token IDs. The verifier does not use the caller container's truthiness. This keeps array-like inputs with non-scalar truth semantics (for example NumPy arrays) on the explicit verifier contract and prevents a mutable/one-shot iterable from being reread between emptiness and element validation.

Text and byte strings, scalars, and other non-iterable values are rejected with a stable `ValueError` at the runtime boundary. Empty `inputTokenIds` and `promptTokenIds` preserve their existing diagnostics. Each detached element is still normalized through `operator.index`; booleans, negative values, floats, and numeric strings remain invalid token IDs.

The detached list is the only token vector forwarded to later artifact-integrity checks and ONNX Runtime session creation.

## Evidence boundary

This is host-side runtime-boundary reliability hardening. It does not constitute new real `Llama-3.2-1B-Instruct` q4 materialization, physical WebGPU working-set, distinct-browser Coordinator relay/latency, cache, or worker-loss/resume evidence for #167.
