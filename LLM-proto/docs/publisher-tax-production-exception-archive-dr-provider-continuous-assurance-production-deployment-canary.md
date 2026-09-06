# Publisher tax exception archive DR provider continuous assurance production deployment canary

Issue #145 moves the continuous-assurance chain from local Worker contracts toward a deployable Cloudflare production topology, while keeping the first deployment canary deliberately read-only.

## Why the canary is read-only

The normal runtime already executes a recurring production cycle. Reusing the same provider write, key-rotation, or DR-exercise actions from a second canary controller could duplicate side effects or race the normal Cron window.

Therefore #145 does **not** call the external provider or pager APIs. It verifies deployed wiring and evidence infrastructure with an `idle` tick before `nextDueAtMs`. Actual external provider/pager operations are reserved for the next controlled provider canary.

This is a safety boundary, not a reduction in evidence requirements.

## Deployment topology

```text
production-canary controller
  -> CONTINUOUS_ASSURANCE_RUNTIME
     -> controlled /__canary/dispatch
        -> same named SQLite Durable Object runScheduled()
           -> ASSURANCE_ENGINE
              -> PROVIDER_ADAPTER  [metadata only in #145]
              -> EVIDENCE_ADAPTER  [metadata only in #145]
              -> PAGER_ADAPTER     [metadata only in #145]
  -> INDEPENDENT_VERIFIER
  -> CANARY_EVIDENCE_BUCKET (R2)
```

The controller never reimplements #137 policy logic. Controlled dispatch reaches the same `ContinuousAssuranceRuntimeState.runScheduled()` method that the runtime Cron handler uses.

## Internal-only Workers

The continuous-assurance runtime, engine, provider adapter, evidence adapter, pager adapter, independent verifier and deployment-canary controller are all intended to be internal Workers.

Their Wrangler configurations use:

- `workers_dev: false`
- `preview_urls: false`
- no public routes
- Service Bindings between Workers
- observability enabled

Provider and pager secret values are never committed. Runtime/engine/controller dispatch/bootstrap secrets are provisioned by the deployment helper rather than embedded in the runtime/engine config body.

## Version, effective config, and deployment identity

Each deployed Worker receives a `version_metadata` binding named `CF_VERSION_METADATA` and a deploy-time `CONFIG_FINGERPRINT_SHA256` var.

The fingerprint is not merely the repository `wrangler*.jsonc` byte digest. The deployment helper hashes the config bytes together with the resolved **non-secret deployment overrides** used for that service. Changing a real provider base URL, pager endpoint, deploy commit input, or another non-secret deploy var therefore changes the effective config identity.

The helper then constructs a redacted deployment identity from:

- deploy commit SHA,
- R2 bucket identity,
- every role/service name,
- every effective config fingerprint.

That identity is canonicalized and hashed as `DEPLOY_MANIFEST_SHA256`. The controller receives the digest at deploy time and records it together with `DEPLOY_COMMIT_SHA` in both the R2 artifact and EvidenceEnvelope payload.

The canary records exactly one deployed identity for each role:

- controller
- runtime
- engine
- provider adapter
- evidence adapter
- pager adapter
- independent verifier

Each identity contains service name, Worker version ID, optional version tag, version timestamp and effective config SHA-256 fingerprint. Duplicate version IDs are rejected by the gate/verifier.

The controller also asks the engine which provider/evidence/pager versions it sees through its own Service Bindings. Those identities must match the versions the controller observes directly. A stale or differently wired adapter therefore fails closed.

The downstream gate does not trust the payload's manifest fields by themselves. The operator supplies the expected deploy commit, expected deployment-manifest digest, and expected config fingerprint for every role; each must exactly match the captured canary evidence.

## Read-only runtime check

The controller first reads the engine snapshot and `nextDueAtMs`. It chooses a logical timestamp before that due time and sends a canary dispatch using the special `deployment-canary-idle` trigger identity.

A clean result requires:

- runtime status `idle`
- durable runtime record `completed`
- replay count `0`
- no provider/evidence/pager action attempts
- no new cycle EvidenceEnvelope
- no new aggregate EvidenceEnvelope
- no failure reason

The same trigger is then dispatched a second time. The Durable Object must return the completed result as a replay without re-running the engine. This confirms deployed idempotency without creating a provider side effect.

## Negative checks

The deployed canary records and enforces:

- an invalid dispatch secret receives `403`
- a duplicate completed dispatch is suppressed
- a synthetic version/config mismatch is rejected by the identity validator
- an untrusted verifier identity is rejected by `validateEvidenceEnvelope()`
- the independent verifier rejects an intentionally incorrect artifact digest

These checks are executed by code. They are not hand-written `true` values accepted without validation.

## R2 artifact and independent verification

The controller canonicalizes the deployment/wiring record, including deploy commit SHA, deployment-manifest digest, exact Worker identities, engine-observed adapter identities, and read-only runtime result. It recomputes SHA-256 and stores the bytes in `CANARY_EVIDENCE_BUCKET`.

The independent verifier understands the deployment-canary evidence kind separately from steady-state cycle/aggregate evidence:

- deployment canary may claim at most `production-candidate`
- steady-state cycle/aggregate semantics remain `production-approved`

For deployment-canary artifact verification, the verifier does more than compare SHA-256. It parses the artifact JSON and checks that its core identity exactly matches the envelope payload:

- canary run and trigger identity
- deploy commit SHA
- deployment-manifest SHA-256
- seven deployed Worker identities
- read-only runtime result
- engine-observed provider/evidence/pager Service Binding identities
- bad-secret and duplicate-suppression negative results

A different R2 blob with a valid digest cannot therefore be substituted for the captured payload.

Before the controller emits the envelope, it requires:

1. capture attestation from the independent verifier,
2. successful re-verification of the correct R2 artifact digest **and artifact↔payload identity**,
3. a full `validateEvidenceEnvelope()` pass using the trusted verifier list,
4. rejection of a deliberately incorrect digest,
5. rejection of a deliberately untrusted verifier identity.

The canary therefore cannot promote a self-reported deployment object into captured evidence by field naming alone.

## Deployment helper

`./scripts/deploy-continuous-assurance-production-canary.mjs` provides three modes:

```bash
cd LLM-proto
node scripts/deploy-continuous-assurance-production-canary.mjs          # plan only
node scripts/deploy-continuous-assurance-production-canary.mjs --dry-run
node scripts/deploy-continuous-assurance-production-canary.mjs --apply
```

The default mode performs no Cloudflare writes.

`--apply` requires Cloudflare account credentials, deploy commit identity, real provider/pager endpoints and all required secret inputs. Secret values are passed to Wrangler through stdin for `secret put`; they are excluded from the redacted deployment manifest and command event log.

Dependency order is:

1. independent verifier
2. provider adapter
3. pager adapter
4. evidence adapter
5. engine
6. runtime
7. production-canary controller

The helper also ensures the R2 evidence bucket exists, injects each effective config fingerprint at deploy time, and binds the redacted deployment-manifest digest into the controller.

After each real `wrangler deploy`, the helper extracts the **actual Worker Version ID** from Wrangler output. Apply mode fails closed if a deployed service does not yield a version ID. The resulting `versionIdentities` list is operational deployment output, not by itself `captured-and-verified` evidence; the deployed controller must still observe those versions through `version_metadata` and produce a verified canary artifact.

## Evidence interpretation

Repository CI, unit tests, a fake deployment runner, Miniflare, and Wrangler `--dry-run` are **not** evidence that these Workers are deployed in a Cloudflare account.

Even running the deployment helper with `--apply` is only `deployment-executed-unverified` unless the deployed controller subsequently produces a genuine `captured-and-verified` deployment-canary artifact with real Worker version metadata, exact deployment manifest binding, and independent verification.

### Cold-start diagnostic

A production account whose assurance-engine Durable Object has never been bootstrapped still fails closed with HTTP 503 and `error=production-canary-engine-snapshot-not-ready`. The response now also includes non-secret machine-readable blocker metadata pointing at #190 (`kind=cold-start-bootstrap-cycle`, `status=design-decision-required`) and states the exact engine state required by the existing canary gate. This is diagnostic only: it does not seed an engine snapshot, relax the deployment canary, or choose a genesis strategy.

No actual Cloudflare deployment or external provider call is performed by repository CI.

## Focused validation

```bash
cd LLM-proto
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary
```

The focused suite covers:

- deployment-canary gate semantics
- exact deploy commit / deployment manifest / per-role config binding
- controller Service Binding / R2 / verifier behavior with deterministic stubs
- artifact byte↔payload binding
- read-only enforcement
- version/config mismatch failure
- bad-secret and duplicate suppression
- deployment ordering, effective config fingerprinting, exact Wrangler version-ID capture and secret redaction

## Next bottleneck

A clean deployment/wiring canary still does not prove the external provider and pager integrations in the deployed account.

The next bottleneck is:

`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary`

That follow-up should use a specifically authorized canary account/window and bounded provider operations, preserving #137 idempotency and existing rollback/emergency-hold controls without competing with the normal production Cron cycle.
