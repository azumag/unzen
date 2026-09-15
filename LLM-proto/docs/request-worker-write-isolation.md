# Request and worker repository write isolation

`RequestRecord` and `WorkerRecord` have a deliberate mutable-read compatibility contract in the durable Coordinator path. Code that obtains an active record through `getRequest()` / `listRequests()` or `getWorker()` / `listWorkers()` can update selected runtime state; the Durable Object adapter uses write-through proxies so this behavior matches the in-memory reference adapter.

That mutable-read contract does not imply that objects supplied to repository write methods remain authoritative after the call.

## Write ownership

`createRequest()` captures every declared request field into a plain repository-owned record before deriving the storage key. `putWorker()` does the same for the worker identity, generation, connection, capability, health, timing, and optional runtime fields. Required fields are read once in declared order, optional fields preserve own-property presence, and caller objects are not enumerated.

Both storage keys are derived from the corresponding owned snapshot. A getter or Proxy therefore cannot return one `requestId` / `workerId` for the key and a different value for the persisted record.

After a successful write, mutating the original request or worker object cannot rewrite repository state. This rule is explicit in `InMemoryRepository` and `DurableObjectRepository` and does not depend on backing-storage structured-clone behavior.

## Mutable reads remain intentional

This change does not detach active request/worker reads. The existing #103 runtime path mutates request observability/stage fields and worker health fields through records returned by the repository. In-memory records remain live, while Durable Object reads remain write-through proxies with worker-generation fencing.

The boundary is therefore:

- writer-retained input objects are detached at `createRequest()` / `putWorker()`;
- active records obtained from repository `get*()` / `list*()` keep their established mutable semantics;
- worker generation replacement and stale-proxy fencing are unchanged.

## Evidence scope

Cross-adapter regressions exercise the contract against a reference-preserving KV implementation, including single-read accessor capture, key/value consistency, retained writer mutation isolation, optional fields, and continued mutable-read behavior.

This is runtime/durability hardening only. It is not evidence for real `Llama-3.2-1B-Instruct` q4 artifacts, physical WebGPU memory, real-model full-vs-multi equivalence, real multi-browser relay/latency, worker-loss resume, or production deployment. Issue #158 remains on HOLD.
