# Production operations rollout (#152)

## Purpose

This is the terminal validator for the publisher tax exception archive DR provider continuous-assurance chain.

It consumes a genuine production-provider-canary EvidenceEnvelope and requires four ordered rollout phases before recurring steady-state operations can be enabled.

A repository fixture pass does **not** prove that an external Cloudflare/provider production rollout happened.

## Preconditions

The exact #149 production provider canary must independently revalidate as `captured-and-verified` / `production-candidate` or stronger. The rollout authorization is bound to its provider/account/storage/archive identity and exact Worker deployment version/config identities.

The authorization requires:

- rollout ID and authorization ID
- change ticket
- bounded global window
- two distinct approvers
- rollback and emergency-hold control IDs
- exact four-phase plan with action budgets and minimum observation windows
- explicit maintenance rotation authorization when rotation is due
- explicit DR exercise authorization/change window

## Phases

1. `observe-only`
   - no key rotation or DR exercise may occur
   - SLO, archive integrity, alerts/incidents and controls are observed
2. `maintenance-enabled`
   - an authorized due old-to-new credential/signing/encryption key transition may occur
   - DR exercise remains forbidden
3. `dr-exercise-enabled`
   - the backup storage path must actually be exercised
   - canonical archive digest and integrity must pass
4. `steady-state-enabled`
   - no new rollout side effect is performed during promotion
   - the phase supplies the recurring operational obligations

Phases cannot be skipped, reordered or overlapped. Each phase has its own independently verified `production-approved` EvidenceEnvelope.

## Fail-closed rules

The rollout holds on any of the following:

- upstream provider-canary validation failure
- provider/account/storage/archive/deployment identity drift
- missing or duplicate two-person approval
- phase skip/order/overlap or insufficient observation duration
- action budget overflow or inconsistent idempotency identities
- RTO/RPO/integrity breach
- provider availability below threshold
- exhausted rolling failure budget
- unresolved critical alert
- active Sev1/Sev2 incident
- active or unknown rollback/emergency control invocation
- unauthorized or invalid key rotation
- DR exercise that does not use backup storage or reproduce the canonical archive digest
- missing future operational obligations

## Terminal result

A clean four-phase completion returns:

- `decision: steady-state-enabled`
- `bottlenecksToIssue: []`
- concrete obligations for next continuous-assurance cycle, next key rotation, next DR exercise, evidence retention, on-call/escalation and rollback/emergency controls

This deliberately ends the validator chain. New validator issues should only be created if a concrete new implementation gap is discovered.

## Focused test

```bash
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout
```
