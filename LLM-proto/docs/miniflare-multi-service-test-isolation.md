# Miniflare multi-service test isolation

Issue #261 tracks intermittent 5,000 ms Vitest timeouts observed in the two heaviest Continuous Assurance Miniflare smoke files while the full `LLM-proto` suite was running with normal file-level parallelism.

## Observation

The same two tests timed out on unchanged `main` and on the #260 working tree when run as part of the fully parallel suite, while the unchanged suite completed when constrained with `--maxWorkers=2`. The #260 tree also produced both a fully passing normal-parallel run and a later run with the same two timeouts. That pattern points to host CPU/I/O contention around repeated TypeScript transpilation and Miniflare/workerd startup rather than a deterministic assertion failure.

The affected files are:

- `tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapter-workers.test.ts`
- `tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-worker.test.ts`

Each file now builds its immutable temporary Worker graph once. Each test invocation still creates/disposes one or more fresh Miniflare runtimes with its own unique persistence directory. They therefore have a materially different resource profile from the lightweight contract tests.

## Test layout

`vitest.config.ts` defines two projects:

1. `standard` runs the ordinary `tests/**/*.test.ts` files with normal Vitest file parallelism.
2. `miniflare-multi-service` contains only the two heavy smoke files, has `maxWorkers: 1` and `fileParallelism: false`, and uses `sequence.groupOrder: 1` so it starts only after the `standard` project has completed.

The standard project uses `sequence.groupOrder: 0`. Vitest runs projects in increasing group order, so the heavy Miniflare processes no longer compete with unrelated test-file workers from the main suite.

This is deliberately a scheduling change, not a weakening of the tests:

- the default 5,000 ms per-test timeout is unchanged;
- assertions are unchanged;
- Miniflare runtime behavior and production HOLD decisions are unchanged;
- the ordinary tests retain their existing parallelism;
- the two heavy files still execute in the normal `npm test` gate.

## Commands

Full gate:

```bash
cd LLM-proto
npm test
```

Only the normal parallel project:

```bash
npx vitest run --project standard
```

Only the serialized multi-service smoke project:

```bash
npx vitest run --project miniflare-multi-service
```

For timing diagnosis, use the verbose reporter and compare the file/test durations reported by Vitest rather than increasing the timeout:

```bash
npx vitest run --project miniflare-multi-service --reporter=verbose
```

If the isolated project still approaches the 5,000 ms test limit on an otherwise idle host, investigate setup/compile/runtime/dispose cost before changing the timeout. A timeout increase must not be used to hide a functional hang or leaked Miniflare runtime.

## Evidence boundary

This scheduling change only addresses reliability of the local/CI test harness. Passing these Miniflare smoke tests remains runtime-observed/contract evidence for the tested Worker boundaries; it is not production deployment evidence and does not alter #158 or the unresolved architecture decisions under #223/#167.

## Phase tracing and immutable build reuse (#261 follow-through)

Each file compiles its unchanged Worker graph in `beforeAll`, with an explicit
5,000 ms hook deadline. `afterAll` removes only that file's temporary build directory.
Runtime instances, R2/DO persistence roots and evidence-call observations remain
per-scenario; only source artifacts are reused. The restart test explicitly releases
the first runtime through an idempotent owner, rather than disposing it twice and
swallowing all cleanup errors.

Opt in to JSON phase traces (also enabled in the CI Test step):

```bash
UNZEN_MINIFLARE_TIMING=1 npm test -- --project miniflare-multi-service
```

`unzen_miniflare_phase` records contain only suite, sample, phase, status and monotonic
elapsed milliseconds. A `started` event precedes each phase, so an interrupted run
identifies the last entered phase. No request body, exception text or credentials are
logged. With the flag absent the helper emits nothing. Logging failures cannot change
test results.

The phases are `compile`, `startup` (constructor through `await mf.ready`),
`request-verification` (the existing scenario and assertions), and `dispose`.
The adapter restart scenario's `request-verification` interval also includes its
intentional first disposal and replacement runtime startup/disposal. Do not add its
nested disposal time to that scenario to infer an exact total.

### Local measurements, 2026-09-08 JST

On Darwin arm64 / Node v24.18.0, the initial instrumented run spent 2,125.22 ms in
seven compilations, versus 461.32 ms in primary startup and 533.90 ms in scenarios.
Sharing builds reduced compilation to two calls / 800.46 ms in the paired run;
Vitest wall time changed from 3.88 s to 2.60 s. These are single-run comparisons,
not a throughput guarantee or a controlled performance benchmark.

Six subsequent runs (three without added load and three with two bounded local
CPU-load processes) passed all eight tests every time. Command wall-time medians
were 2,914.70 ms / 2,960.72 ms respectively; the largest recorded individual phase
was 500.45 ms / 538.64 ms. Every run had two compilation and seven primary runtime
samples, and no failed phase. Existing host load and OS filesystem caches were not
controlled; fresh Vitest processes do not establish a cold filesystem cache.

[Raw local phase samples and source digests](evidence/miniflare-multi-service-20260908.json)
record the exact conditions. This establishes repeatability for the sampled local
conditions, not immunity to arbitrary machine overload. Production runtime code,
assertions, and the 5,000 ms per-test deadline are unchanged.
