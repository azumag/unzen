# AdaptiveChunkDispatcher request ID contract

`AdaptiveChunkDispatcher.run(requestId)` treats request identifiers as untrusted runtime input even though the TypeScript surface accepts `string`.

## Contract

- Explicit request IDs must be actual strings and must contain at least one non-whitespace character.
- Validation reuses the shared `inferenceRequestId()` identity boundary from `src/types.ts`.
- Valid identifiers are preserved exactly as supplied. The dispatcher does not trim, normalize, or introduce an additional character policy.
- Omitted request IDs continue to use the dispatcher-generated `adaptive-N` identity.
- Validation happens before transport connections, assignment counters, worker residency, or artifact-ledger state are changed.

This prevents asserted or decoded non-string values and blank identifiers from reaching Coordinator URL construction or being emitted as accepted run identities.

## Regression coverage

`tests/adaptive-chunk-dispatcher.test.ts` verifies that blank and non-string runtime values fail before any transport connection, valid padded identities are preserved exactly, and generated default identities remain stable.

Related: #523, #167.
