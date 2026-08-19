# Publisher tax exception archive DR provider continuous assurance provider adapter canary

Issue #143 adds the internal adapter layer consumed by the continuous-assurance engine from #141.

## Scope

The engine keeps the existing #137 automation as the policy authority. This layer only converts those deterministic actions into internal Service Binding calls and provider/evidence/pager boundaries:

```text
scheduled runtime (#139)
  -> ASSURANCE_ENGINE (#141)
     -> PROVIDER_ADAPTER
        -> provider audit / retrieval / health / rotation / DR exercise
     -> EVIDENCE_ADAPTER
        -> R2 artifact archive/load
        -> INDEPENDENT_VERIFIER
     -> PAGER_ADAPTER
        -> operator paging
```

The production service names are:

- `unzen-llm-continuous-assurance-provider-adapter`
- `unzen-llm-continuous-assurance-evidence-adapter`
- `unzen-llm-continuous-assurance-pager-adapter`
- `unzen-llm-continuous-assurance-independent-verifier`

The engine and all four internal Workers are configured with `workers_dev: false`, `preview_urls: false`, and no public routes. The engine calls the first three adapters through Service Bindings; the evidence adapter calls the verifier through a Service Binding.

## Provider adapter

Supported paths are exactly the paths already used by the #141 engine executor:

- `/provider/audit`
- `/provider/archive/retrieve`
- `/provider/health`
- `/provider/keys/rotate`
- `/provider/dr/exercise`

The adapter:

- requires `POST`
- requires a bounded `x-unzen-idempotency-key`
- preserves that key on the upstream call
- adds the provider credential only from the `PROVIDER_API_TOKEN` secret binding
- bounds request and response JSON size
- rejects malformed/non-JSON provider responses
- validates the minimum response shape required by #137/#135
- maps provider failures to explicit fail-closed adapter errors

`PROVIDER_API_BASE_URL` is non-secret routing metadata. The token is not present in git or Wrangler vars.

## Evidence adapter and R2

The evidence adapter implements:

- `/evidence/cycle/archive`
- `/evidence/cycle/capture`
- `/evidence/aggregate/capture`
- `/evidence/artifact/load`
- `/evidence/artifact/verify`

Cycle archive content is canonicalized, SHA-256 is recomputed by the adapter, and the bytes plus digest/retention/idempotency metadata are written to `EVIDENCE_BUCKET` (R2). A caller-supplied digest is never accepted as proof of stored bytes.

Cycle capture reloads the exact retained R2 object and recomputes SHA-256 before asking the independent verifier to approve the production payload. Aggregate capture similarly builds a canonical artifact, computes its digest, stores it in R2, and then invokes the verifier.

Only an exact verifier attestation for the evidence kind, run ID and requested readiness can produce a `captured-and-verified` / `production-approved` envelope. The existing `validateEvidenceEnvelope()` still performs artifact load, SHA-256 comparison, trusted-verifier checking and attestation matching when the engine later consumes the envelope.

## Independent verifier

`unzen-llm-continuous-assurance-independent-verifier` is a separate Worker so evidence production and evidence verification are not the same Service Binding.

For cycle capture it checks, among other conditions:

- cycle/run identity
- primary and backup retrieval integrity
- zero failure/RTO/RPO/integrity breach counters
- armed rollback and emergency-hold controls
- retained evidence digest format

For aggregate capture it checks:

- aggregate run identity
- non-empty cycle set
- zero RTO/RPO/integrity breaches
- positive remaining failure budget
- valid next schedule

For later artifact verification it independently recomputes the bytes' SHA-256 and requires the envelope verification identity/timestamp to match the deterministic attestation.

## Pager adapter

`/page` requires the body `dedupeKey` to equal the incoming `x-unzen-idempotency-key`. The same key is propagated to the paging provider. Retry is bounded to at most three attempts; provider `409` is interpreted as a successful duplicate suppression rather than issuing a second page.

`PAGER_API_TOKEN` is a required secret binding and is not committed.

## Canary gate

`runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAdapterCanaryGate()` accepts only the evidence kind:

`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-adapter-canary`

A clean result requires effective `captured-and-verified` evidence at `production-candidate` or higher, plus:

- exact scope/cron/scheduled trigger identity
- exact engine/provider/evidence/pager/verifier service identities
- SHA-256 configuration fingerprint
- one successful receipt for each required adapter action
- preserved idempotency keys
- artifact locator/digest and verifier identity
- pager dedupe identity
- negative checks proving missing idempotency, provider failure, digest mismatch and verifier failure are rejected, and pager duplication is suppressed

A self-reported or hand-written production-looking payload cannot satisfy the gate.

## Local validation

```bash
cd LLM-proto
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters
```

The focused suite covers adapter contracts, the canary evidence gate, and a Miniflare/workerd multi-service smoke. The runtime smoke uses an emulated R2 bucket and a real Service Binding between the evidence adapter and independent verifier, including artifact persistence across a Miniflare restart.

## Evidence interpretation

A unit-test or Miniflare pass proves the repository contract and local workerd wiring only. It does **not** prove that the four Workers are deployed in a Cloudflare account, that provider/pager secrets have been provisioned, that a real archive provider accepted the calls, or that a scheduled production canary occurred.

The next clean bottleneck is therefore:

`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary`

That follow-up should deploy the target adapter/verifier Workers, provision R2 and required secrets, then run a controlled scheduled runtime -> engine -> adapters canary and capture independently verifiable evidence from the actual environment.
