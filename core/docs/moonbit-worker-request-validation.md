# MoonBit worker request validation boundary

`core/packages/client/src/worker/moonbit-worker-protocol.ts::validateMoonbitWorkerRequest()` treats `MessageEvent.data` as runtime-untrusted input.

Successful validation returns a new plain `MoonbitWorkerMessage` snapshot. Shared envelope fields and every declared variant field are captured once, then validation is performed only against those captured values. The worker therefore cannot observe a different `type`, generation, request identity, cache setting, export name, or other top-level field after an accessor/Proxy-backed input has passed validation.

For execute requests, the captured `ArrayBuffer`, arguments array, and optional ABI object keep their references. Validation verifies the captured wasm buffer size and ABI metadata, but does not introduce an additional copy. This preserves the existing transfer/ownership behavior while removing top-level TOCTOU drift.

Malformed or unreadable request objects fail closed before worker state is touched. This mirrors both `validateMoonbitWorkerResponse()` and the QuickJS request/response validation boundaries.

Regression coverage lives in `core/packages/client/tests/moonbit-worker-protocol-request-snapshot.test.ts` and covers single-read accessors, init/execute/cancel snapshots, post-validation source mutation, and unreadable Proxy input.
