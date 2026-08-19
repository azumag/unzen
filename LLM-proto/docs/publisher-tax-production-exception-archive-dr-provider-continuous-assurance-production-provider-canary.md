# Production provider canary

Issue #149 adds the first bounded production-provider exercise after the read-only deployment/wiring canary.

## Scope

The provider canary is intentionally narrow. It permits exactly five action kinds:

- provider health/readiness probe
- provider audit stream read
- primary archive retrieval and digest/integrity check
- backup archive retrieval and digest/integrity check
- pager canary delivery plus duplicate suppression check

It does **not** permit credential/key rotation, archive mutation/deletion, DR promotion, failover, restore promotion, or other destructive actions.

## Required upstream evidence

The exact #145 production-deployment-canary `EvidenceEnvelope` is embedded in the provider-canary payload and independently revalidated. The canary controller fails before touching provider/pager Service Bindings unless that upstream evidence is effectively `captured-and-verified` and `production-candidate` or stronger.

The operator authorization also binds the exact deployed Worker version IDs and config fingerprints from the upstream canary, so a same-run-ID payload or deployment substitution does not satisfy the gate.

## Operator authorization

Execution requires:

- authorization ID and change ticket
- bounded start/expiry window
- two distinct approvers
- provider/account/primary-storage/backup-storage/archive identity
- expected archive SHA-256 digest
- exact five-action allowlist
- exact deployment version/config identity set

The controller is operator-triggered only. `wrangler.production-provider-canary.jsonc` has no Cron trigger, `workers_dev: false`, `preview_urls: false`, and no public routes.

## Execution and idempotency

The bounded executor reuses the existing provider and pager Service Binding adapters. Its provider call set is fixed to `/provider/health`, `/provider/audit`, and `/provider/archive/retrieve`; it never calls `/provider/keys/rotate` or `/provider/dr/exercise`.

Each provider operation gets a deterministic canary idempotency key. Pager delivery is sent twice with the same dedupe key: the first must be accepted and the second must be deduplicated.

Any upstream HTTP error, authorization/window failure, archive digest or storage identity mismatch, or pager dedupe failure aborts the canary.

## Evidence capture

On success the controller writes a canonical provider-canary artifact to R2 containing the exact authorization, receipts, deployment-canary run identity, and negative-check results. A dedicated internal verifier validates capture, recomputes artifact SHA-256, checks the exact artifact-to-payload binding, and re-verifies the envelope at `captured-and-verified` / `production-candidate`.

The production-provider gate then independently validates the envelope and re-runs the upstream deployment gate before allowing promotion.

## Evidence boundary

Passing repository CI uses fixture Service Bindings only. It proves the gate/controller/verifier contracts and internal-only configuration; it does **not** prove that a real provider, real archive storage, real pager, or real Cloudflare production deployment was exercised.

Actual provider execution must be backed by genuine externally captured and independently verified evidence.

## Focused test

```bash
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary
```

## Next bottleneck

A clean canary yields:

`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout`

That follow-up should decide how bounded canary evidence becomes a controlled steady production rollout, rather than adding another proof-only validator without an operational gap.
