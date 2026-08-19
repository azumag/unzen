# Continuous assurance production rollout execution harness

Issue #163 closes the execution gap between the bounded #149 production provider canary and the #152 terminal rollout validator.

The #152 module remains the only authority that can return `steady-state-enabled`. This harness does not introduce another readiness gate. It performs the authorized phase actions, captures independently verifiable evidence, and then passes that evidence back through #152.

## Operator model

The rollout controller is an internal Cloudflare Worker:

- `workers_dev: false`
- `preview_urls: false`
- no public routes
- no Cron trigger
- secret-protected `/__run` endpoint reachable only through Service Binding

For operator invocation, run the local-only Worker configured by `worker-runtime/wrangler.production-rollout-invoker.jsonc`. It binds to `127.0.0.1:8792` and uses a `remote: true` Service Binding to the deployed rollout controller.

Do not put `ROLLOUT_CONTROLLER_SECRET`, provider credentials, pager credentials, or authorization bearer values into request JSON, issue comments, deployment manifests, or logs.

## Phase input

Each `/invoke` request contains only operational evidence and authorization data:

- `phase`
- `providerCanaryEvidence`
- `rolloutAuthorization`
- `previousPhaseEvidences`
- `phaseStartedAtMs`
- `replayCount`

The Worker uses `Date.now()` for the completion/check time. The request cannot override the current time, minimum provider availability, allowed failure budget, recurring cycle cadence, key-rotation cadence, DR cadence, retention horizon, on-call route, or escalation target. Those are deployment configuration.

## Exact sequence

The harness accepts only:

1. `observe-only`
2. `maintenance-enabled`
3. `dr-exercise-enabled`
4. `steady-state-enabled`

Before any current-phase provider action, the runner invokes the existing #152 gate against the previously verified prefix. Missing future phases are the only expected hold reasons. A prior semantic failure prevents the next phase from starting.

After the current phase is captured and independently verified, #152 is run again including the new evidence. Therefore a phase cannot be used as a bridge to the next phase merely because its artifact was syntactically captured.

## Actions by phase

Every phase performs the common bounded observations:

- provider health / operational state
- provider audit cursor read
- primary archive retrieval and canonical digest check
- backup archive retrieval and canonical digest check
- pager canary delivery followed by duplicate suppression check

Additional actions are phase-gated:

- `maintenance-enabled`: `credential-key-rotation` only when the rollout authorization says rotation is required and supplies the expected old identities and due deadline.
- `dr-exercise-enabled`: `dr-failover-exercise` only against the authorized backup storage and canonical archive digest.
- `observe-only` and `steady-state-enabled`: no rollout-specific rotation or DR side effect.

Every logical action has a deterministic idempotency key based on rollout ID, phase sequence, phase name, and action name. Replay increments the attempt count but preserves the provider-side idempotency identity.

## Fail before maintenance / DR side effects

The health call is deliberately the first read-only action. Before key rotation or DR exercise can occur, the runner requires:

- expected rollback and emergency-hold control IDs
- both controls armed
- provider availability at or above the configured threshold
- remaining error budget above zero
- zero RTO breaches
- zero RPO breaches
- zero integrity failures
- no unresolved critical alert
- no active Sev1/Sev2 incident
- no active or unknown control invocation

Any violation aborts the phase before rotation or DR execution.

## Evidence capture

`createProductionOperationsRolloutPhaseCapture()` writes a canonical artifact to the existing `unzen-continuous-assurance-evidence` R2 bucket. The artifact binds:

- rollout/phase run ID
- full rollout authorization
- phase payload
- action receipts and idempotency keys

The dedicated internal rollout verifier independently checks capture and artifact retrieval, recomputes SHA-256, validates authorization/action/identity/SLO bindings, and issues `captured-and-verified / production-approved` attestation only on a clean record.

The final `steady-state-enabled` invocation additionally receives operational obligations derived by the deployed Worker from configured cadence/retention values. A successful final invocation must return the real #152 terminal report with:

- `status=pass`
- `decision=steady-state-enabled`
- `bottlenecksToIssue=[]`

## Deployment

The original #160/#161 deployment result remains the source of truth for the seven-service #145 core identity. `scripts/deploy-continuous-assurance-production-rollout.mjs` consumes that result and deploys only the derived rollout verifier/controller services. It does not recompute or redefine the core deployment manifest.

The manual production workflow runs the derived helper in `plan`, `dry-run`, and `deploy` modes after the base helper. `ROLLOUT_CONTROLLER_SECRET` is scoped only to the deploy step and is provisioned to Wrangler via stdin.

## What repository CI proves

Repository tests prove sequencing, fail-close behavior, idempotency contracts, evidence capture/verifier contracts, internal-only configuration, secret redaction, and integration with the existing #152 terminal gate.

They do **not** prove that Cloudflare Workers were deployed, that an external provider/pager was contacted, or that a genuine four-phase production rollout completed. Those claims require real external artifacts under Issue #158.

## Focused test

```bash
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-rollout-harness
```
