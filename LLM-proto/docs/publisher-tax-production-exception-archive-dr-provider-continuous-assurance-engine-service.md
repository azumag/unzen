# Publisher tax production exception archive DR provider continuous assurance engine service

Issue #141 connects the scheduled Worker runtime from #139 to the continuous-assurance policy engine from #137 without duplicating the policy logic.

## Position in the chain

```text
steady-state operations (#135)
  -> continuous-assurance automation (#137)
  -> scheduled Worker runtime (#139)
  -> continuous-assurance engine service (#141)
  -> provider/evidence/pager adapter canary
```

The engine service is an **internal orchestration/runtime boundary**. A local Miniflare pass or a deployable Wrangler configuration is not proof that Cloudflare production deployment, provider operations, evidence capture, or operator paging have run successfully.

## Architecture

```text
Cron Worker (#139)
  -> ASSURANCE_ENGINE Service Binding
  -> unzen-llm-continuous-assurance-engine
       -> ENGINE_STATE.getByName(scope)
       -> ContinuousAssuranceEngineState (SQLite Durable Object)
            current verified steady-state snapshot
            per-trigger execution journal
            scope single-flight state
       -> #137 continuous-assurance automation
            -> PROVIDER_ADAPTER
            -> EVIDENCE_ADAPTER
            -> PAGER_ADAPTER
```

The #137 function `runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAutomation()` remains the authoritative due/idle/overdue, evidence, paging, and #135 revalidation policy engine. #141 does not implement a second, weaker production decision path.

## Durable state and replay

`ContinuousAssuranceEngineState` stores:

- the exact current #135 report and aggregate EvidenceEnvelope;
- the current aggregate run ID used as a compare-and-set base;
- one execution journal per deterministic runtime trigger key;
- replay count and base aggregate run ID;
- running / interrupted / completed state;
- the first engine or adapter failure;
- persisted final result and committed aggregate run ID;
- one active trigger key per assurance scope.

A completed trigger returns the persisted result without running #137 or adapters again. An interrupted trigger may be reclaimed only with a larger runtime `replayCount`. A different trigger key cannot start while the same scope is active.

For a successful `pass`, the next verified snapshot and the completed journal entry are committed in the same SQLite `transactionSync()` block. The current aggregate run ID must still equal the journal's base aggregate run ID. A mismatch fails closed as `engine-snapshot-cas-conflict`.

`idle` and `hold` results complete the journal without advancing the current verified snapshot.

## Bootstrap trust boundary

The initial snapshot is accepted only through the bootstrap endpoint and requires the `ENGINE_BOOTSTRAP_SECRET` secret binding. The secret value is intentionally absent from git and Wrangler vars.

Before storage, bootstrap requires:

- upstream #135 report status `pass`;
- exact steady-state evidence kind;
- effective `captured-and-verified` evidence at `production-approved` readiness;
- artifact load and SHA-256 digest verification through `EVIDENCE_ADAPTER`;
- independent verifier attestation matching the envelope and configured trusted verifier set;
- exact aggregate run ID and exact report input EvidenceEnvelope;
- exact aggregate cycle run set;
- independent validation of every preserved historical cycle EvidenceEnvelope.

Self-reported or hand-written production-approved-looking evidence without a working external loader and trusted verifier cannot seed engine state.

## Adapter boundaries

### `PROVIDER_ADAPTER`

#137 action context and deterministic idempotency keys are forwarded to:

- `/provider/audit`
- `/provider/archive/retrieve`
- `/provider/health`
- `/provider/keys/rotate`
- `/provider/dr/exercise`

### `EVIDENCE_ADAPTER`

Operational evidence is routed to:

- `/evidence/cycle/archive`
- `/evidence/cycle/capture`
- `/evidence/aggregate/capture`
- `/evidence/artifact/load`
- `/evidence/artifact/verify`

The last two endpoints are used to construct `EvidenceValidationOptions`; final evidence validation still happens through the existing `validateEvidenceEnvelope()` implementation.

### `PAGER_ADAPTER`

Operator paging is routed to `/page` with the original deterministic dedupe key.

Provider credentials, evidence-store credentials, and pager credentials belong to the adapter services, not this policy engine.

## Cloudflare configuration

`worker-runtime/wrangler.engine.jsonc` defines:

- service name `unzen-llm-continuous-assurance-engine`, matching the #139 `ASSURANCE_ENGINE` binding;
- compatibility date `2026-08-20`;
- `nodejs_compat`;
- `workers_dev: false` and no public routes;
- SQLite `ContinuousAssuranceEngineState` Durable Object migration;
- `PROVIDER_ADAPTER`, `EVIDENCE_ADAPTER`, and `PAGER_ADAPTER` Service Bindings;
- observability;
- trusted verifier identity metadata, but no credential or bootstrap-secret value.

The repository-pinned Miniflare/workerd version predates the production compatibility date, so the local runtime smoke uses `2025-01-01` only inside the test harness. Production configuration remains `2026-08-20` and is asserted separately.

## Validation

Focused command:

```bash
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine
```

The focused suite covers both the TypeScript engine core and Miniflare Worker runtime, including trigger identity, persisted completed results, atomic snapshot CAS, idle/hold behavior, replay rules, Service Binding idempotency, artifact load + independent verification, protected bootstrap, real #137 idle execution, completed duplicate suppression, interrupted replay/scope single-flight, and internal-only configuration.

## Evidence interpretation

The Miniflare tests demonstrate local workerd behavior and configuration contracts. They do **not** show that:

- `unzen-llm-continuous-assurance-engine` is deployed in a Cloudflare production account;
- the runtime and engine Service Binding are live in production;
- the provider/evidence/pager adapter services exist or are deployed;
- real provider archive retrieval, key rotation, DR exercise, evidence capture, or paging has occurred;
- a production provider canary has passed.

Those claims require independently captured deployed-runtime/provider evidence.

## Next bottleneck

A clean #141 result points to:

`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-provider-adapter-canary`

That follow-up should implement/deploy the provider, evidence, and pager adapter services, connect their secret-managed external integrations, run the scheduled runtime -> engine -> adapters chain in a controlled canary, and capture independently verifiable evidence without weakening #137/#135 gates.
