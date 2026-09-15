# MoonBit worker rejection correlation boundary

`core/packages/client/src/worker/moonbit-worker.ts::postRejectedMessage()` emits best-effort responses for malformed or otherwise rejected MoonBit worker messages.

The rejected path treats the incoming object as runtime-untrusted. It captures `generationId` and `type` once, and for `execute` / `cancel` captures `requestId` once, before deciding whether a correlated response can be emitted. Response construction uses only those captured primitive values, so getter- or Proxy-backed inputs cannot pass an addressability check with one identity and then drift before the rejection response is built.

The change does not broaden addressability. Non-object inputs, messages without a numeric `generationId`, unknown message types, and `execute` / `cancel` messages without a non-empty string `requestId` still receive no correlated response.

Accepted MoonBit worker requests already use `validateMoonbitWorkerRequest()` to return a plain request snapshot. Together, accepted and rejected request paths avoid validate-then-reread drift at the MoonBit worker transport boundary.

Regression coverage is in `core/packages/client/tests/moonbit-worker-rejection-correlation.test.ts`.
