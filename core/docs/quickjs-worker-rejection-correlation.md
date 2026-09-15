# QuickJS worker rejection correlation boundary

`core/packages/client/src/worker/quickjs-worker.ts::postRejectedMessage()` handles best-effort responses for malformed or otherwise rejected worker messages.

The rejected path treats the incoming object as runtime-untrusted. It snapshots `generationId` and `type` once, and for `execute` / `cancel` snapshots `requestId` once, before checking whether a correlated response can be emitted. Response construction uses only those captured primitive values. This prevents getter- or Proxy-backed inputs from presenting one correlation identity during the addressability check and another while the rejection response is built.

The change does not broaden addressability. Non-object inputs, messages without a numeric `generationId`, unknown message types, and `execute` / `cancel` messages without a non-empty string `requestId` still receive no correlated response.

Accepted worker requests use the separate `validateWorkerRequest()` plain-snapshot boundary documented in `quickjs-worker-request-validation.md`. Together, accepted and rejected request paths avoid validate-then-reread drift at the QuickJS worker transport boundary.

Regression coverage is in `core/packages/client/tests/quickjs-worker-rejection-correlation.test.ts`.
