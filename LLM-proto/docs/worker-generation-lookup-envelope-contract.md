# Worker generation lookup runtime contract

`WorkerRegistry.getByGeneration()` can inspect both the active worker set and the revoked-generation archive. Its branded TypeScript `WorkerGeneration` parameter is therefore validated again at runtime before either lookup domain is touched.

The lookup requires `generation` to be a non-empty runtime string. Malformed decoded/asserted values — including `null`, `undefined`, non-string primitives, arrays, objects, functions, `Symbol`, empty strings, and whitespace-only strings — fail closed with `UnzenError` / `ErrorCode.ProtocolViolation` before active-worker enumeration or revoked-generation archive access.

Valid lookup behavior is unchanged:

- a current generation resolves to its active worker record;
- a revoked generation resolves to the existing detached archived snapshot;
- an otherwise-valid unknown generation returns `undefined`.

Focused runtime-boundary coverage is in `tests/worker-registry-runtime-boundary.test.ts`; its counting repository proves malformed generations are rejected before `listWorkers()` is called. Existing revocation-isolation tests continue to cover detached archived snapshots.

This change is coordinator/runtime contract hardening only. It is not real Llama-3.2-1B q4 materialization, physical WebGPU/GPU-memory evidence, real multi-browser checkpoint relay, worker-loss resume, or production deployment evidence for #167/#158.