# Publisher tax exception archive DR provider continuous assurance Worker runtime (#139)

## Scope

This stage turns the deterministic continuous-assurance tick from #137 into a deployable Cloudflare Workers runtime boundary.

It adds:

- an ES-module Worker `scheduled()` entrypoint,
- a deterministic named SQLite-backed Durable Object,
- a durable execution ledger for delivery/replay/idempotency state,
- an internal `ASSURANCE_ENGINE` Service Binding,
- a Cron Trigger and Durable Object migration/binding in `worker-runtime/wrangler.jsonc`,
- Miniflare runtime smoke coverage for scheduled delivery, restart persistence, duplicate suppression, replay recovery, concurrency, and failure persistence.

This does **not** prove that the Worker has been deployed to a production Cloudflare account or that a real archival provider is connected. The tests are local Miniflare runtime evidence plus configuration/contract checks.

## Runtime architecture

```text
Cloudflare Cron Trigger
  -> Worker scheduled()
  -> CONTINUOUS_ASSURANCE_STATE.getByName(scope)
  -> ContinuousAssuranceRuntimeState Durable Object
       -> SQLite execution_ledger
       -> ASSURANCE_ENGINE Service Binding
            -> #137 continuous-assurance tick / provider adapters
```

The public Worker `fetch()` surface exposes only `/health`. Runtime state and execution are not exposed through public HTTP routes.

## Durable execution ledger

The Durable Object stores one row per deterministic trigger key:

`<scope>:<cron>:<scheduledTimeMs>`

The ledger preserves:

- scope / cron / scheduled time,
- `running` or `completed` state,
- replay count and attempt count,
- lease expiry,
- cycle ID,
- action idempotency keys returned by the assurance engine,
- the first operational failure,
- paging outcome,
- latest cycle and aggregate evidence run IDs,
- the final engine result,
- started/completed/updated timestamps.

A completed duplicate delivery returns the persisted result and does not call the engine again.

A second delivery while a `running` row still owns its lease returns `in-progress` and does not create another active execution.

If an engine call is interrupted, the row remains `running`. After the lease expires, the same deterministic trigger key can be delivered again. The replay count increases while the cycle/trigger identity stays stable. The original first failure is retained as audit history even when a later replay succeeds.

## Failure and paging semantics

The Worker runtime does not replace #137 failure semantics. It persists them.

- An engine result with `failureReason` is stored as the first operational failure.
- A paging failure remains in the separate paging object.
- A transient runtime/Service Binding failure is stored as `worker-runtime-engine-failed:<reason>` and leaves the row recoverable as `running`.
- A later successful replay may complete the row, but the original first failure remains available for audit.

## Internal service boundary

`ASSURANCE_ENGINE` is a Service Binding. The runtime does not call a public assurance-engine URL and does not embed provider credentials.

The configuration contains binding/service names only. Provider credentials and provider-specific network access belong in the engine/provider-adapter deployment, not in this Worker source or `wrangler.jsonc`.

## Wrangler configuration

`worker-runtime/wrangler.jsonc` defines:

- production compatibility date `2026-08-20`,
- `nodejs_compat`,
- Cron Trigger `*/5 * * * *`,
- SQLite Durable Object binding `CONTINUOUS_ASSURANCE_STATE`,
- migration tag `v1` with `new_sqlite_classes`,
- internal `ASSURANCE_ENGINE` Service Binding,
- non-secret runtime vars for scope and lease duration,
- observability enabled.

The repository-pinned Miniflare/workerd build predates the production compatibility date and rejects `2026-08-20` as a future date. Therefore **Miniflare smoke only** uses `2025-01-01`, which is already supported by the pinned emulator. The production Wrangler configuration remains `2026-08-20`, and a test asserts that distinction.

## Runtime smoke coverage

Focused command:

```bash
cd LLM-proto
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-runtime
```

The smoke tests verify:

1. scheduled delivery reaches the named Durable Object and calls the internal engine binding,
2. engine result/action keys/evidence run IDs are persisted,
3. completed duplicate delivery does not repeat engine actions,
4. state survives a Miniflare restart,
5. interrupted `running` execution replays with the same trigger identity after lease expiry,
6. concurrent duplicate delivery is serialized while the lease is active,
7. original operational failure and paging failure remain distinct,
8. only `/health` is exposed publicly,
9. production Wrangler settings are explicit and contain no credential values.

## Evidence boundary

A passing Miniflare runtime smoke means the scheduled Worker / Service Binding / SQLite Durable Object contract works in the local workerd-compatible runtime covered by the test.

It does not mean:

- a production Worker is deployed,
- the Cron Trigger is active in a Cloudflare account,
- `ASSURANCE_ENGINE` is deployed,
- provider credentials or APIs are configured,
- real recurring provider evidence has been captured.

Those claims require deployed runtime evidence.

## Next bottleneck

A clean Worker-runtime result points to:

`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-engine-service-deployment`

The next stage should deploy the `ASSURANCE_ENGINE` service behind the Service Binding, connect real provider adapters and evidence capture/verification paths, and produce independently verifiable deployed-runtime evidence without weakening the #137/#135 gates.
