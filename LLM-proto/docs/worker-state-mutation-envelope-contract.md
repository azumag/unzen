# Worker state-mutation runtime identity contract

`WorkerRegistry.markDisconnected()`, `markBusy()`, and `markIdle()` can sit downstream of coordinator/transport state. Their branded TypeScript `WorkerId` and `WorkerGeneration` parameters are therefore not sufficient runtime validation for decoded or asserted values.

Before any active-worker repository lookup, all three state-mutation methods require:

- `workerId` to be a non-empty runtime string;
- `generation` to be a non-empty runtime string.

Malformed values fail closed with `UnzenError` / `ErrorCode.ProtocolViolation`. In particular, `null`, `undefined`, primitives other than strings, arrays, objects, functions, `Symbol`, empty strings, and whitespace-only strings do not reach repository key construction and cannot alter worker stage or `currentSegment`.

`markBusy()` retains its existing segment-cursor boundary: after identity validation, `segmentIndex` must be a non-negative safe integer before the worker record is read or mutated.

Existing generation fencing is unchanged for valid identities:

- an unknown worker remains a no-op;
- a stale generation remains a no-op;
- the current generation can transition to disconnected, busy, or idle exactly as before.

Focused coverage is in `tests/worker-registry-runtime-boundary.test.ts`, including repository-read counters that prove malformed identities are rejected before active-worker lookup.

This is coordinator/runtime trust-boundary hardening only. It is not real Llama-3.2-1B q4 materialization, physical WebGPU/GPU-memory evidence, real multi-browser checkpoint relay, worker-loss resume, or production deployment evidence for #167/#158.