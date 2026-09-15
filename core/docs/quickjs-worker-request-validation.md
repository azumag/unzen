# QuickJS worker request validation boundary

`core/packages/client/src/worker/worker-protocol.ts::validateWorkerRequest()` is a runtime trust boundary for `MessageEvent.data` received by the QuickJS worker.

A successful validation returns a new plain `WorkerMessage` snapshot. The validator captures each declared scalar field once (`protocolVersion`, `generationId`, `type`, and variant-specific scalar fields) and does not retain caller accessors or Proxy identity. This prevents a request from presenting one value during validation and another during dispatch.

For `execute` messages, the validator intentionally preserves the captured `args` array reference. It does not deep-copy or recursively validate argument values. Ownership of executable code/arguments is established immediately afterwards by `snapshotQuickJsCall()` in `quickjs-worker.ts`; keeping this as a separate boundary avoids duplicate serialization/deep-copy work while ensuring the fields dispatched into it are the same values that passed validation.

Malformed or unreadable request objects fail closed before worker state is touched. The response path follows the same single-capture/plain-snapshot rule through `validateWorkerResponse()`.

Regression coverage lives in `core/packages/client/tests/worker-protocol-request-snapshot.test.ts` and includes single-read accessors, source mutation after validation, plain init/cancel snapshots, and unreadable Proxy inputs.
