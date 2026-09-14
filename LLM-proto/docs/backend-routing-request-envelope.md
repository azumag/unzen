# Backend routing runtime envelopes

`capabilityMatchesRequest()` is a routing trust boundary. TypeScript `InferenceRequest` and `WorkerCapability` types do not prove that decoded, asserted, accessor-backed, or Proxy-backed runtime data is stable or valid.

Before candidate-selection logic evaluates a request, it captures the routing-relevant caller-owned fields exactly once into owned local state:

- `protocolVersion`
- `maxTokens`
- `requiresStreaming`

The predicate validates that captured state and performs every request-side routing decision from the same values. The original request object is not consulted again after capture, and the validated routing envelope is frozen before use. This prevents a valid-first / altered-second accessor from passing validation with one value and changing routing with a later re-read.

The request fails closed unless:

- the root is a non-null, non-array object;
- `protocolVersion` is a string supported by this host;
- optional `maxTokens` is a non-negative safe integer;
- optional `requiresStreaming` is a boolean;
- reading the routing fields itself completes without throwing.

Optional-field behavior is unchanged: omitted `maxTokens` imposes no context-window requirement, while omitted or false `requiresStreaming` does not require a streaming-capable backend.

The capability input is separately checked with the canonical `validateWorkerCapability()` schema before routing. Candidate selection therefore evaluates two owned, validated sides: the request routing envelope and the worker capability snapshot. Malformed containers, unsupported versions, invalid modalities, invalid numeric limits, and invalid booleans match no candidate rather than relying on JavaScript coercion or incidental `TypeError` behavior.

Request validation here remains intentionally limited to fields used by candidate selection. `requestId`, `modelId`, and `input` are not routing facts in `capabilityMatchesRequest()`; their complete validation belongs at the execution boundary that consumes them.

Regression coverage in `tests/backend-registry.test.ts` uses valid-first / altered-second accessors for all three request routing fields and verifies that each is read exactly once. A throwing accessor is also covered to keep the fail-closed behavior explicit.

This hardening supports the reliability work tracked by #167 but is not evidence of real Llama-3.2-1B q4 materialization, physical WebGPU working-set behavior, real multi-browser relay latency, or worker-loss resume behavior. It does not change the production operations HOLD in #158.
