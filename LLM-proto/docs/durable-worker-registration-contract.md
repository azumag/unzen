# Durable worker registration contract

`WorkerRegistry.register()` is a runtime trust boundary. TypeScript types describe coordinator code, but they do not validate worker registration payloads decoded from WebSocket / JSON traffic or direct runtime callers.

Before the registry reads registration fields or mutates durable routing state, the registration envelope itself must be a non-null, non-array object. Revoked Proxies and other values whose array classification throws are mapped to the same owned envelope diagnostic instead of leaking a native Proxy exception. After that container check, a registration must satisfy all of the following:

- `workerId` is a non-empty, non-whitespace string.
- `tier` is exactly `WorkerTier.TIER_1`, `TIER_2`, or `TIER_3`.
- `vramMB` is finite and greater than zero.
- `connectionId` is a non-empty, non-whitespace string.

`WorkerRegistry.register()` captures `workerId`, `tier`, and `vramMB` exactly once, in that fail-fast order, before active-worker lookup, generation changes, or repository writes. Normal property lookup semantics are retained, including inherited values. If a getter or Proxy `get` trap throws, the registry replaces the caller-thrown value with the stable field-specific `worker registration ... could not be read` diagnostic; the thrown value is never inspected, stringified, or coerced, and later registration fields are not read after the failure. The validated values are detached into a registry-owned snapshot, and all later lookup, capability refresh, reconnect/revocation, and record construction use that snapshot rather than re-reading the caller-owned registration.

Invalid `tier` and `vramMB` diagnostics obey the same trust-boundary rule. Primitive invalid values retain useful text where safely representable, while object/function values are rendered as the registry-owned token `unknown`. Diagnostic generation never invokes caller-controlled `Symbol.toPrimitive`, `valueOf`, or `toString` hooks.

The public `DurableCoordinator.registerWorker()` wrapper also treats property access itself as untrusted runtime work. `workerId`, `tier`, and `vramMB` keep their historical normal property lookup semantics, including inherited values, but each reached field is read exactly once. If a getter or Proxy `get` trap throws, the caller-thrown value is neither stringified nor coerced; registration fails immediately with that field's existing `ErrorCode.ProtocolViolation` diagnostic. Later registration fields are not read after the inaccessible field, and no worker state has been mutated yet. The registry repeats validation on the already-owned values because it is also a separately exported runtime boundary; valid coordinator calls therefore retain the same effective semantics without trusting direct registry callers.

Validation happens before existing-worker lookup, capability refresh, revocation, generation creation, or repository writes. Consequently, a rejected malformed envelope cannot trigger incidental field-access failures after state has changed, a rejected same-connection refresh cannot poison an existing worker's tier/VRAM, and a rejected reconnect cannot revoke the currently valid generation.

Valid registration semantics are unchanged:

- a new worker creates a fresh generation;
- the same worker on the same connection refreshes capability fields while preserving its generation;
- the same worker on a different connection revokes the old generation and creates a new one.

## Busy-state segment cursor

`WorkerRegistry.markBusy()` is also a runtime boundary because decoded coordinator data can reach the segment cursor even when TypeScript declares it as `number`.

Before reading or mutating the worker record, `segmentIndex` must be a non-negative safe integer. Negative, fractional, `NaN`, infinite, unsafe-integer, and non-number asserted values are rejected before `stage` or `currentSegment` can change. For an otherwise-valid segment index, the existing generation fence is unchanged: unknown workers and stale generations remain no-ops, while the current generation transitions to `busy` and stores that segment index.

## Revoked-generation snapshot isolation

`DurableObjectRepository` exposes active worker records through write-through compatibility proxies. A reconnect reuses the same `worker:<workerId>` durable key for a fresh generation, so the registry must never retain the old generation's repository-backed proxy as historical state after that key is deleted and reused.

`WorkerRegistry` therefore snapshots a worker record when it is revoked. A revoked-generation lookup also returns a fresh detached copy. This guarantees that mutating data obtained from `getByGeneration(oldGeneration)` cannot write through to the replacement generation or modify the registry's archived revoked snapshot.

## Active worker proxy generation fence

Active records returned by `DurableObjectRepository.getWorker()` and `listWorkers()` remain write-through current-state views for compatibility with the coordinator contract. Each proxy captures the worker generation that existed when the record was read. Before persisting a later property mutation, the repository re-reads the durable key and requires that the stored generation still matches that captured generation.

If the worker was deleted or a reconnect replaced it with a new generation, mutation of the stale proxy is local-only: it cannot recreate the deleted key and cannot alter the replacement generation. Current-generation proxy mutations continue to persist normally.

Callers should still treat generation identity as the authority across reconnects rather than retaining worker objects as durable historical handles.

This contract protects coordinator-side durable routing state only. Passing these checks is not evidence that reported VRAM is physically accurate, that a real WebGPU device can execute the assigned segment, or that the 1B multi-browser relay/resume path has been demonstrated.

Related: #103, #167, #1348, #1438.
