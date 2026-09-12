# Worker routing VRAM requirement contract

`WorkerPool.getAvailableWorker()` and `WorkerRegistry.getAvailableWorker()` are coordinator-side routing boundaries. Their `requiredVramMB` argument is runtime data, even when normal callers derive it from an already validated manifest.

A routing requirement is valid only when it is a positive finite number. `0`, negative values, `NaN`, `Infinity`, and `-Infinity` are rejected before worker iteration or ranking begins.

This fail-closed check matters particularly for `NaN`: JavaScript evaluates comparisons such as `worker.vramMB < NaN` to `false`, which would otherwise make an invalid requirement look satisfiable and allow an idle worker to be selected.

For valid requirements, selection semantics are unchanged:

- only idle workers are eligible;
- workers must report at least the required VRAM;
- lower worker tier is preferred;
- within the same tier, more reported VRAM is preferred.

The legacy in-memory `WorkerPool` and durable `WorkerRegistry` intentionally enforce the same numeric boundary so coordinator behavior does not diverge between execution paths.

This contract does not prove that worker-reported VRAM matches physical GPU memory, that a selected artifact is resident in GPU memory, or that the real 1B multi-browser WebGPU relay/resume path from #167 has been demonstrated. It only prevents malformed coordinator-side VRAM requirements from failing open during worker selection.
