# Publisher tax production exception archive DR provider production readiness

Issue #128 adds the production-readiness decision after the verified archival-provider DR pilot.

This gate is still an **evidence/readiness gate**. A passing result is `production-candidate`, not `production-approved`. Actual provider production cutover remains a separate step.

## Implementation

- `src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-readiness.ts`
- `tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-readiness.test.ts`

Focused command:

```bash
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-production-readiness
```

## Gate chain

```text
archive DR operations
  -> verified provider pilot (#126)
  -> provider production readiness (#128)
  -> publisher-tax-filing-production-exception-archive-dr-provider-production-cutover
```

## Provenance

Both the production-readiness evidence and every recurring provider run are independently validated with the shared `validateEvidenceEnvelope()` path.

Production-readiness evidence must be effective `captured-and-verified` with at least `production-candidate` readiness. Each recurring run must be effective `captured-and-verified` with at least `verified-pilot` readiness. Self-reported evidence cannot satisfy either production-readiness requirement.

## Recurring verified operation

The gate requires at least three distinct verified provider run IDs across at least two restore windows. It derives these counts from the supplied validated run set instead of trusting summary counters in the readiness payload.

Every verified run preserves provider/account/storage/replica/archive identity, records primary and backup retrieval operation IDs, performs a restore with post-restore digest verification, and remains within the RTO/RPO, backup-age, and replication-lag objectives inherited from the verified provider pilot.

## Production restore window and approval

The proposed production restore window records:

- window ID
- start/end time
- change ticket ID
- explicit scope
- approver IDs

At least two distinct operator approvals must be present and linked to the window.

## Monitoring and error budget

Production readiness records an evaluated window, verified run count, failures, RTO/RPO breaches, integrity failures, allowed failure budget, and remaining failure budget.

Any archive-integrity failure, RTO/RPO breach, or exhausted error budget is a hold condition.

## Credential and key rotation

The gate requires current credential/key rotation evidence with:

- credential set ID
- signing key ID
- encryption key ID
- managed secret-store boundary
- last rotation timestamp
- next rotation deadline
- rotation evidence ID

An unmanaged secret boundary or overdue rotation holds promotion.

## Provider failover exercise

The outage/failover policy must reference a verified recurring run that actually restored from the backup storage ID. Merely naming an existing run is insufficient.

## Preserved controls

Production readiness preserves the verified pilot's:

- recovery owner / on-call / escalation identity
- incident IDs
- retention / legal hold / operational hold / deletion-review state
- Coordinator/CDN signed-runner network boundary

Rollback and emergency-hold control IDs plus explicit hold criteria are also required.

## Next bottleneck

A clean production-readiness gate reports:

`publisher-tax-filing-production-exception-archive-dr-provider-production-cutover`

That next step should execute a separately approved production cutover without treating this readiness report itself as production approval.
