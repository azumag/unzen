# Miniflare multi-service test isolation

Issue #261 tracks intermittent 5,000 ms Vitest timeouts observed in the two heaviest Continuous Assurance Miniflare smoke files while the full `LLM-proto` suite was running with normal file-level parallelism.

## Observation

The same two tests timed out on unchanged `main` and on the #260 working tree when run as part of the fully parallel suite, while the unchanged suite completed when constrained with `--maxWorkers=2`. The #260 tree also produced both a fully passing normal-parallel run and a later run with the same two timeouts. That pattern points to host CPU/I/O contention around repeated TypeScript transpilation and Miniflare/workerd startup rather than a deterministic assertion failure.

The affected files are:

- `tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapter-workers.test.ts`
- `tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-worker.test.ts`

Each test invocation builds a temporary Worker graph and creates/disposes one or more Miniflare runtimes. They therefore have a materially different resource profile from the lightweight contract tests.

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
