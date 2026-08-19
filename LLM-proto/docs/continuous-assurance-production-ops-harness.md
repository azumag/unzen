# Continuous assurance production ops harness

Issue #160 / PR #161 adds the operational harness needed before Issue #158 can obtain genuine external production evidence. Issue #163 extends that harness so the four #152 rollout phases are executed and evidenced by code rather than by hand-built phase JSON.

## What this harness does

The manual GitHub Actions workflow `.github/workflows/continuous-assurance-production-ops.yml` supports three explicit modes:

- `plan` — build the redacted deployment plan only. This is the default and does not authenticate to Cloudflare.
- `dry-run` — authenticate and run Wrangler deploy preflight for every production service without applying deployment changes.
- `deploy` — provision the evidence R2 bucket if needed, provision Worker secrets via stdin, and deploy the production Worker set plus the production rollout controller/verifier.

The workflow is `workflow_dispatch` only and uses the GitHub `production` environment. It is not triggered by push, pull request, or schedule.

## Deployment scope

The #145 deployment-canary identity remains defined by the original seven core services:

1. independent verifier
2. provider adapter
3. pager adapter
4. evidence adapter
5. assurance engine
6. continuous-assurance runtime
7. production deployment-canary controller

The original deployment script computes the core config fingerprints and deployment manifest SHA-256 from those seven services first. It then deploys the #149 services:

8. production provider-canary verifier
9. production provider-canary controller

The provider-canary controller receives the exact core deploy commit, core manifest digest, and core config-fingerprint map. Post-deployment provider-canary configuration therefore cannot silently redefine the #145 deployment identity.

Issue #163 adds a second, derived deployment step that consumes the already-written redacted base deployment result and deploys:

10. production rollout verifier
11. production rollout controller

The derived script does not recompute the seven-service #145 identity. It injects the exact base deploy commit, base manifest SHA-256, and base config-fingerprint map into the rollout controller.

## Required GitHub production environment configuration

Secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `PROVIDER_API_TOKEN`
- `PAGER_API_TOKEN`
- `ENGINE_BOOTSTRAP_SECRET`
- `CANARY_DISPATCH_SECRET`
- `CANARY_CONTROLLER_SECRET`
- `PROVIDER_CANARY_CONTROLLER_SECRET`
- `ROLLOUT_CONTROLLER_SECRET`

Variables:

- `PROVIDER_API_BASE_URL`
- `PAGER_API_URL`
- `PROVIDER_CANARY_ONCALL_ROUTE`
- `PROVIDER_CANARY_ESCALATION_TARGET`
- `ROLLOUT_ONCALL_ROUTE`
- `ROLLOUT_ESCALATION_TARGET`

Secret values must not be copied into workflow inputs, issue comments, PR bodies, deployment artifacts, or logs. The rollout secret is scoped only to the deploy step and is provisioned through Wrangler secret stdin, not command-line arguments.

## Invoking the internal provider canary

The production provider-canary Worker remains internal-only:

- `workers_dev: false`
- `preview_urls: false`
- no public route
- no Cron trigger

To invoke it without creating a public endpoint, use `worker-runtime/wrangler.production-provider-canary-invoker.jsonc`. This local Worker listens on `127.0.0.1:8791` and uses a Service Binding with `remote: true` to call the deployed provider-canary controller.

The invoker itself is not deployed. It accepts only loopback requests and forwards `PROVIDER_CANARY_CONTROLLER_SECRET` to the internal `/__run` endpoint. A runner must provide that secret through a temporary local dev-secret file or equivalent non-loggable secret mechanism and remove the temporary file after use.

The operator request still has to contain genuine #145 deployment-canary evidence and the #149 bounded authorization object. The invoker does not weaken or bypass the #149 gate.

## Executing the four production rollout phases

After a genuine #149 provider canary has been independently verified, use the Issue #163 harness documented in [`continuous-assurance-production-rollout-execution-harness.md`](./continuous-assurance-production-rollout-execution-harness.md).

The rollout controller is also internal-only and operator-triggered. The local invoker config `worker-runtime/wrangler.production-rollout-invoker.jsonc` listens on `127.0.0.1:8792` and uses a `remote: true` Service Binding to the deployed rollout controller. It does not expose a public URL or add a Cron trigger.

Run phases in exact order:

1. `observe-only`
2. `maintenance-enabled`
3. `dr-exercise-enabled`
4. `steady-state-enabled`

Each invocation supplies the genuine provider-canary evidence, rollout authorization, verified evidence from all previously completed phases, the current phase start timestamp, and replay count. The controller obtains the current time and SLO/error-budget policy from deployment configuration; the operator cannot override those values in the request.

The controller executes the allowed Service Binding actions, captures a canonical R2 phase artifact, obtains independent `production-approved` verification, and immediately re-runs the existing #152 gate. The next phase must not start if the current verified prefix has any semantic hold reason.

## Evidence meaning

`plan`, `dry-run`, and repository CI remain repository/runtime contract evidence only.

Even `deploy` reports `deployment-executed-unverified`; deployment alone is not #145 `captured-and-verified` evidence. Issue #158 remains open until the real Cloudflare deployment canary, bounded provider canary, and all four #152 rollout phases produce independently verified external evidence and the terminal gate returns:

- `status=pass`
- `decision=steady-state-enabled`
- `bottlenecksToIssue=[]`

## Focused tests

```bash
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-ops-harness
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-rollout-harness
```
