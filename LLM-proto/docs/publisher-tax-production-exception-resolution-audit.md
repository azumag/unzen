# Publisher tax production exception resolution audit

Issue #116 adds the contract gate that follows the production exception operations runbook introduced by #91 / PR #114.

> A passing fixture is still contract evidence. It does not prove that a real provider, support team, publisher notification system, or tax operator completed these steps in production.

## Position in the gate chain

```text
production monitoring reconciliation
  -> production exception operations runbook     #91
  -> production exception resolution audit       #116
  -> production exception audit archive/retention next bottleneck
```

Implementation:

- `src/workers-coordinator-publisher-tax-production-exception-resolution-audit.ts`
- `tests/workers-coordinator-publisher-tax-production-exception-resolution-audit.test.ts`

Focused validation:

```bash
cd LLM-proto
npm run test:workers-publisher-tax-production-exception-resolution
```

## Resolution model

Every upstream runbook action must have exactly one `WorkersCoordinatorPublisherTaxProductionActionResolution`.

Two outcomes are allowed:

- `resolved`
  - requires a positive terminal `resolvedAtMs`
  - must not carry a future-review record
- `carried-forward`
  - must not claim a terminal resolution timestamp
  - requires owner, reason, and `nextReviewAtMs`
  - next review must be later than the audit capture time

This prevents an open exception from disappearing merely because the audit ran.

## Corrected filing reconciliation

A runbook action with `action: 'prepare-correction'` requires exactly one provider correction outcome.

The outcome is linked to:

- runbook action ID
- provider filing ID
- approved production filing window ID
- provider correction submission ID
- provider accepted/rejected state
- observed timestamp

The gate rejects correction evidence for a different provider filing or filing window.

## Support escalation resolution

Support escalation state must match the action resolution state.

- resolved action -> escalation must be `closed`
- carried-forward action -> escalation must be `carried-forward`

Closed escalations require a close timestamp and no future-review timestamp. Carried-forward escalations require a future review and must not claim closure.

## Publisher-facing final status

Every provider filing touched by an action must have exactly one resolution-audit status for that action.

Resolved actions may use:

- `resolved`
- `corrected-accepted`
- `duplicate-confirmed`
- `replay-cleared`

Carried-forward actions must use:

- `carried-forward`

This keeps publisher-facing state consistent with operator/support state.

## Immutable identity audit

The resolution audit must preserve the identities that existed before resolution:

- runbook action ID
- support escalation IDs
- original publisher status update IDs

`createWorkersCoordinatorPublisherTaxProductionExceptionIdentityFingerprint()` derives a deterministic canonical fingerprint from those IDs. The gate recomputes it from the upstream report and rejects an audit record that changes, drops, or invents identities.

The fingerprint is an identity-integrity contract, not a cryptographic production signature. Production archival integrity remains a later evidence concern.

## Control integrity

The audit carries forward without modification:

- duplicate-filing suppression IDs
- rollback decision ID
- rollback plan ID
- emergency hold switch ID

Any identity drift causes a hold.

## Security boundary

The existing signed-runner boundary remains required:

- every allowed origin appears in CSP `connect-src`
- sandbox remains exactly `allow-scripts`
- COOP remains `same-origin`
- COEP remains `require-corp`
- at least one non-Coordinator/CDN attempt is captured as blocked
- any non-allowlisted unblocked attempt fails the gate

## Report

`WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport` exposes:

- the complete upstream exception operations report
- action resolution records
- provider correction outcome evidence
- support resolution evidence
- terminal/carried-forward publisher status evidence
- immutable identity audit records
- resolution summary counts
- duplicate-filing suppression state
- rollback/emergency-hold identity
- security-boundary state
- `failureReason`
- `bottlenecksToIssue`

A clean gate points to:

```text
publisher-tax-filing-production-exception-audit-archive-retention
```

That follow-up should define durable archival/export evidence, retention windows, immutable provider/operator audit history, retrieval/deletion policy, and production-grade artifact integrity for completed exception cases.

## Repository-wide validation

```bash
cd LLM-proto
npx tsc --noEmit
npm test
```
