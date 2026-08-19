# Publisher tax production exception archive DR provider post-cutover reconciliation

Issue #133 adds the reconciliation gate after the bounded archival-provider production cutover.

This is still an **evidence gate**. The contract tests exercise the decision logic with controlled artifacts; they do not prove that a real archival provider remained healthy after a real production cutover. A real operational claim requires externally captured provider artifacts that pass the shared artifact loader, SHA-256, trusted verifier, and independent attestation path.

## Implementation

- `src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-post-cutover-reconciliation.ts`
- `tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-post-cutover-reconciliation.test.ts`

Focused command:

```bash
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-post-cutover-reconciliation
```

## Gate chain

```text
provider production readiness (#128)
  -> bounded production cutover (#131)
  -> post-cutover reconciliation (#133)
  -> publisher-tax-filing-production-exception-archive-dr-provider-steady-state-operations
```

## Exact cutover binding

The upstream cutover report now preserves its exact `cutoverInputEvidence`. The reconciliation gate re-validates the supplied cutover evidence and compares it with that exact snapshot.

A second payload that reuses the same cutover run ID is therefore insufficient: changing the payload after the cutover gate passed produces `cutover-input-mismatch`.

## Observation window

Post-cutover reconciliation requires a bounded observation window that:

- starts no earlier than cutover completion
- begins no later than the end of immediate cutover monitoring, avoiding an unobserved gap
- ends after immediate cutover monitoring
- satisfies an explicit positive minimum duration
- is fully complete before the reconciliation artifact is captured

The gate does not hard-code an arbitrary production observation duration. The independently verified evidence records the declared minimum duration and the gate checks the actual interval against it.

## Provider audit / log evidence

The reconciliation payload contains a provider audit stream identity and cursor plus multiple audit records.

Each record preserves:

- provider / account identity
- primary and backup storage identity
- replica site / region
- archive ID / canonical content digest
- exact cutover run ID
- provider operation / trace / restore execution IDs
- observation timestamp and outcome

At least one audit record must extend beyond the immediate cutover monitoring window. Provider audit failures hold reconciliation. Audit warnings must map to an alert that is itself reconciled.

## Archive re-retrieval

The gate requires fresh production archive retrieval from **both primary and backup storage** during the observation window.

For each retrieval it checks:

- retrieval operation ID
- exact storage identity
- archive ID
- canonical digest
- integrity check ID / pass status
- request/completion timestamps inside the observation window

This verifies that a successful cutover did not leave only the active copy readable while the backup path silently degraded.

## Alerts and incidents

Every alert emitted by the immediate cutover monitoring report must appear in the reconciliation set. New post-cutover alerts may also be included.

Critical alerts must be resolved. Critical/warning alerts carry an explicit disposition. Alert-to-incident references must point to a reconciliation record.

Baseline cutover incident IDs are preserved. Active Sev1/Sev2 incidents hold steady-state promotion; resolved or monitoring records remain auditable through owner, escalation, reconciliation, and related-alert identity.

## Rollback and emergency hold

Rollback and emergency-hold control IDs remain identical to the approved cutover and both controls must stay armed.

Control invocations during the observation window are allowed only when they are explicitly reconciled. An invocation that remains active is a hold condition. A resolved invocation may pass when it has immutable invocation/reconciliation identity and a valid resolution timestamp.

## SLO and error budget

Post-cutover SLO evidence records:

- policy ID / version
- exact observation interval
- production operation count / failure count
- RTO and RPO breach counts
- archive integrity failures
- observed and required provider availability
- allowed and remaining failure budget

RTO/RPO breach, integrity failure, availability below the declared verified policy threshold, or exhausted error budget holds reconciliation.

## Credential, retention, and operations posture

The cutover credential set, signing key, and encryption key identities must remain unchanged through this reconciliation window. The window must finish before the approved key-rotation deadline.

Retention/legal-hold/operational-hold/deletion-review state is preserved exactly. Recovery owner, on-call route, escalation target, and baseline incident identity remain linked to the same operational chain.

## Signed-runner network boundary

The reconciliation evidence preserves the cutover allowlist, CSP, sandbox, COOP, and COEP boundary. Coordinator/CDN-external network attempts must remain blocked, and the evidence must include a negative blocked attempt.

## Next bottleneck

A clean reconciliation result reports:

`publisher-tax-filing-production-exception-archive-dr-provider-steady-state-operations`

That next step should move from one bounded post-cutover observation window to recurring production operations: scheduled reconciliations, rolling SLO/error-budget windows, recurring archive retrieval/integrity checks, key rotation, DR/failover exercises, incident/control review, and long-lived provider evidence retention.