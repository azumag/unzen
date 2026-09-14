# Stream cursor repository isolation

Issue #760 makes the streaming cursor storage boundary explicit and consistent across `InMemoryRepository` and `DurableObjectRepository`.

## Ownership contract

`putStreamCursor()` treats the supplied `StreamCursor` as caller-owned runtime input. The repository reads `requestId`, `lastCommittedSegment`, `totalSegments`, and `updatedAt` exactly once, does not enumerate the caller object, and persists a new plain snapshot built from those captured values.

This prevents accessors or Proxies from changing the persisted key or progress between validation/use sites, and it prevents a retained caller reference from mutating stored progress after the write has completed.

## Read contract

`getStreamCursor()` returns another detached snapshot rather than exposing the stored record. Mutating a returned cursor therefore does not advance progress or rewrite the stored request identity, total segment count, or timestamp.

Progress changes remain explicit: callers may mutate their detached local value, but the change becomes durable only after a later `putStreamCursor()` call.

## Adapter consistency

The Durable Object adapter does not rely on Cloudflare storage structured-clone behavior for this guarantee. It performs the same snapshot-on-write and snapshot-on-read operations as the in-memory adapter, so reference-preserving test storage and production durable storage have the same observable repository semantics.

## Regression coverage

`tests/stream-cursor-repository-isolation.test.ts` runs the same checks against both adapters, including a Durable Object repository backed by reference-preserving KV storage. It verifies:

- each caller-owned cursor field is read exactly once and the cursor is not enumerated;
- mutating the original object after `putStreamCursor()` cannot change stored progress;
- mutating a value returned by `getStreamCursor()` cannot change stored progress; and
- a later explicit `putStreamCursor()` still advances streaming progress normally.
