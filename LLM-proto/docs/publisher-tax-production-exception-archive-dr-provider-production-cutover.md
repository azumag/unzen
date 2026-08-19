# Publisher tax production exception archive DR provider production cutover

Issue #131 adds the bounded production-cutover gate after provider production readiness.

This module is an **evidence/decision gate**. Unit tests exercise the contract with synthetic artifacts. A passing contract test is not proof that a real archival provider production cutover occurred. A real cutover claim requires externally captured artifacts that pass the shared artifact loader, SHA-256, trusted-verifier, and independent-attestation path.

## Implementation

- `src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-cutover.ts`
- `tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-cutover.test.ts`

Focused command:

```bash
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-production-cutover
```

## Gate chain

```text
verified provider pilot (#126)
  -> provider production readiness (#128)
  -> bounded provider production cutover (#131)
  -> publisher-tax-filing-production-exception-archive-dr-provider-post-cutover-reconciliation
```

## Provenance boundary

The exact production-readiness evidence is re-validated and must remain effective `captured-and-verified` at `production-candidate` or stronger. The cutover evidence itself must be effective `captured-and-verified` at `production-approved`.

A hand-written `production-approved` literal is not sufficient. Without an artifact loader, digest match, trusted verifier, and matching independent attestation, the evidence remains invalid or not evaluated.

`production-approved` here describes the evidence readiness accepted by this gate; it does not magically turn synthetic test fixtures into a real provider operation.

## Authorization binding

One cutover authorization is bound to the exact:

- production-readiness run ID
- production restore window ID
- change ticket ID
- two-person approver set
- credential set ID
- signing key ID
- encryption key ID

Authorization and execution must stay inside the approved production window, and execution must begin before authorization expiry.

## Live cutover execution evidence

The cutover payload records:

- provider operation ID
- provider trace ID
- restore execution ID
- actual source storage ID
- execution start/end
- recovery-point timestamp
- primary/backup snapshot timestamps
- replication lag
- archive ID and observed digest
- post-cutover integrity check ID/status

Archive identity and digest must remain identical to the production-readiness evidence. Recovery duration, recovery-point age, backup age, and replication lag are re-evaluated against the upstream DR objectives.

## Immediate monitoring

The monitoring record spans the cutover execution and requires:

- provider health = healthy
- integrity status = pass
- zero RTO breaches
- zero RPO breaches
- zero integrity failures
- zero unresolved critical alerts

Any of these failures holds promotion.

## Rollback and emergency hold

The readiness-stage rollback and emergency-hold control IDs must remain identical. Both controls must be armed before execution and remain armed afterward.

If rollback or emergency hold is invoked, an invocation reconciliation ID is required and the cutover remains on hold. A reconciled invocation is traceable evidence, not a reason to promote a failed cutover.

## Preserved identity and security boundary

The gate preserves:

- provider/account/primary-storage/backup-storage/replica/archive identity
- credential/signing/encryption key identity
- retention/legal-hold/operational-hold/deletion-review state
- recovery owner/on-call/escalation and incident identity
- Coordinator/CDN allowlist
- CSP `connect-src`
- sandbox `allow-scripts` only
- COOP/COEP isolation
- a blocked negative non-Coordinator/CDN network attempt

## Next bottleneck

A clean cutover points to:

`publisher-tax-filing-production-exception-archive-dr-provider-post-cutover-reconciliation`

That follow-up should reconcile the cutover against a longer observation window, provider audit/log evidence, any alert/incident/control invocation, archive retrieval/integrity state, and the long-lived production operating posture.
