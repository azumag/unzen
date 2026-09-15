# WorkerPool read ownership contract

The legacy `WorkerPool` remains an active routing dependency for `Pipeline`, `SpanPipeline`, and `SpanRouter`. Registration values therefore form a runtime trust boundary even though `WorkerInfo.id`, `tier`, and `vramMB` are declared `readonly` in TypeScript.

## Stored records and public views

`WorkerPool` keeps its repository-owned `WorkerInfo` records internal. Public methods that expose a worker return a cached guarded live view of that stored record:

- `register()`
- `get()`
- `getAvailableWorker()`
- `getTimedOutWorkers()`
- `allWorkers()`

Repeated reads of the same stored record return the same view. Re-registering the same worker ID installs a new stored record and therefore a new view. A retained view from the replaced record remains attached only to that old record.

## Protected routing fields

The guarded view rejects `set`, `deleteProperty`, and `defineProperty` operations for:

- `id`
- `tier`
- `vramMB`

These fields determine map identity, worker priority, and VRAM eligibility. They may only change through a new validated `register()` call. Failed mutations occur before the stored record changes.

This prevents runtime JavaScript callers from bypassing registration validation to rewrite routing identity, claim a more stable tier, or advertise additional VRAM.

## Operational live fields

The legacy compatibility contract still permits write-through mutation of operational state exposed on a guarded view, including:

- `status`
- `lastHeartbeat`
- `currentSegment`

Internal `WorkerPool` methods continue to mutate the stored record directly. External operational writes through a current guarded view remain visible to subsequent reads and routing decisions.

## Why `getTimedOutWorkers()` is guarded too

Although the original issue explicitly called out registration and ordinary read/selection paths, `getTimedOutWorkers()` also returns stored `WorkerInfo` values. Returning those values raw would provide a bypass around the same routing-field fence, so timeout results follow the same guarded-view contract.

## Regression coverage

`tests/worker-pool-read-guard.test.ts` verifies that:

- protected fields cannot be assigned, deleted, or redefined from any public worker-return path;
- failed spoof attempts do not change worker lookup or VRAM/tier selection;
- operational fields remain live and writable;
- repeated reads preserve view identity for the same stored record;
- a retained view from before re-registration cannot affect the replacement record.
