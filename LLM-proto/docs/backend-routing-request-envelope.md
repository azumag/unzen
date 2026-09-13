# Backend routing request runtime envelope

`capabilityMatchesRequest()` is a routing trust boundary. Its TypeScript `InferenceRequest` type does not prove that decoded or otherwise asserted runtime data is valid.

Before candidate-selection logic reads request routing fields, the predicate now fails closed unless:

- the request is a non-null, non-array object;
- `protocolVersion` is a string supported by this host;
- optional `maxTokens` is a non-negative safe integer;
- optional `requiresStreaming` is a boolean.

A malformed routing envelope returns `false`; it does not route the candidate and does not rely on incidental JavaScript coercion or `TypeError` behavior. Valid routing semantics are unchanged: text capability, streaming support, context-window capacity, and model availability continue to decide candidate eligibility.

This contract is intentionally limited to fields used by candidate selection. Full inference-request execution validation belongs at the execution boundary rather than being duplicated here.

This hardening supports the reliability work tracked by #167 but is not evidence of real Llama-3.2-1B q4 materialization, physical WebGPU working-set behavior, real multi-browser relay latency, or worker-loss resume behavior.
