# Publisher tax production exception archive disaster recovery operations

Issue #123 adds the recurring disaster-recovery operations gate after the archive restore / integrity drill.

This is a **contract/evidence gate**. A passing report does not by itself prove that a real archival provider, real production account, or real cross-region recovery operation was exercised. Provider evidence is validated through the shared `EvidenceEnvelope`; self-reported evidence remains self-reported, while `captured-and-verified` requires artifact loading plus independent verification.

## Implementation

- `src/workers-coordinator-publisher-tax-production-exception-archive-disaster-recovery-operations.ts`
- `tests/workers-coordinator-publisher-tax-production-exception-archive-disaster-recovery-operations.test.ts`
- `tests/workers-coordinator-publisher-tax-production-exception-archive-dr-failed-drill-incident.test.ts`

Focused command:

```bash
npm run test:workers-publisher-tax-production-exception-archive-dr
```

## Gate chain

```text
production exception resolution audit
  -> archive / retention
  -> archive restore / integrity drill
  -> disaster recovery operations (#123)
  -> publisher-tax-filing-production-exception-archive-dr-provider-pilot
```

## What the gate validates

### Scheduled restore cadence

The evidence records a schedule ID, cadence, last successful restore drill, and next due time. The next due time must equal the last successful drill plus the configured cadence, and the report fails if the drill is overdue.

### RTO and RPO

The gate separates recovery time objective (RTO) from recovery point objective (RPO):

- recovery duration must remain at or below `rtoMs`
- age of the recovered point at recovery start must remain at or below `rpoMs`

An incident record does not make an RTO/RPO breach acceptable. A breach is still a hold condition; the incident record proves that the breach was operationally captured.

### Backup freshness and replication lag

Primary and backup snapshot timestamps are recorded separately. The gate computes backup age and requires the supplied replication lag to agree with the snapshot timestamps. Backup age and replication lag must remain within their declared thresholds.

### Ownership and incident escalation

Recovery ownership is explicit:

- recovery owner
- on-call route
- escalation target

A failed upstream restore drill requires a `restore-drill-failed` incident record. Primary unavailability, backup recovery use, overdue drills, and threshold breaches likewise require incident records linked to the upstream restore attempt. An incident record never converts the underlying failed drill or threshold breach into a pass; it proves the operational escalation was captured separately. Incident records include trigger, severity, owner, escalation target, status, and opened-at timestamp.

### Provider provenance

Provider/account/storage/replica identifiers live inside a shared `EvidenceEnvelope` payload. The gate calls `validateEvidenceEnvelope()` before consuming them.

A self-reported provider envelope may support contract/runtime evidence but **does not prove a real archival-provider run**. A hand-written `captured-and-verified` claim is not enough; the existing artifact loader, digest verification, trusted verifier, and independent attestation requirements still apply.

### Identity and retention preservation

The DR operations report must preserve:

- archive ID
- archive content digest
- retention policy snapshot
- legal / operational hold state
- deletion eligibility and deletion-review state

The DR gate never deletes evidence and does not change deletion eligibility.

### Security boundary

The existing signed-runner boundary remains mandatory:

- every allowed origin must be present in CSP `connect-src`
- sandbox remains exactly `allow-scripts`
- COOP remains `same-origin`
- COEP remains `require-corp`
- at least one non-Coordinator/CDN attempt must be observed as blocked
- any unblocked non-allowed origin fails the gate

## Next bottleneck

A clean DR operations gate reports:

`publisher-tax-filing-production-exception-archive-dr-provider-pilot`

That follow-up should replace fixture/self-reported archival-provider metadata with a provider pilot using independently captured artifacts, real storage/replica retrieval evidence, scheduled restore execution, measured RTO/RPO, and provider/account identity that can be verified without weakening the existing provenance rules.
