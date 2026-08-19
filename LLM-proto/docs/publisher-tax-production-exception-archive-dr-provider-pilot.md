# Publisher tax production exception archive DR provider pilot

Issue #126 adds the verified archival-provider pilot after recurring disaster-recovery operations.

This gate is deliberately stricter than the preceding DR operations gate. The DR operations gate may consume valid self-reported provider metadata while labeling its provenance honestly. The provider pilot **requires effective `captured-and-verified` evidence at `verified-pilot` readiness or above**.

A hand-written `captured-and-verified` object is not sufficient. The shared `validateEvidenceEnvelope()` path must be able to load the referenced artifact, recompute and match its SHA-256 digest, trust the declared verifier, and receive a matching independent verifier attestation.

## Implementation

- `src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-pilot.ts`
- `tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-pilot.test.ts`

Focused command:

```bash
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-pilot
```

## Gate chain

```text
production exception resolution audit
  -> archive / retention
  -> archive restore / integrity drill
  -> disaster recovery operations (#123)
  -> DR provider pilot (#126)
  -> publisher-tax-filing-production-exception-archive-dr-provider-production-readiness
```

## Provider pilot evidence

The verified artifact carries the provider/account/storage identities used during the pilot and is bound to the exact DR input evidence that produced the upstream DR report.

Required identity includes:

- provider name and account ID
- primary storage ID
- backup storage ID
- replica site ID and replica region
- archive ID and canonical archive content digest
- recovery owner, on-call route, escalation target, and incident IDs
- retention / legal hold / operational hold / deletion-review snapshot

The gate rejects a replayed or substituted DR input whose schedule, objectives, ownership, incidents, archive identity, or retention state no longer match the upstream report.

## Primary and backup retrieval

The pilot must prove that **both** storage paths are retrievable, even when the scheduled restore itself uses primary storage.

Each retrieval records:

- provider operation/request ID
- storage ID
- provider locator
- archive ID
- observed archive digest
- request and completion timestamps

Both observed digests must match the upstream archive digest.

## Scheduled restore and objectives

The artifact records a provider restore execution linked to the same DR schedule ID. It includes restore execution ID, source storage ID, recovery start/end, recovery point timestamp, post-restore integrity-check ID, and observed archive digest.

The provider pilot re-applies the upstream DR objectives:

- recovery duration <= RTO
- recovery-point age <= RPO
- backup age <= maximum backup age
- replication lag <= maximum replication lag

Passing an independent evidence verifier does not waive an objective breach.

## Provenance boundary

The pilot requires `evidenceSupportsReadiness(validation, 'verified-pilot')`. Therefore:

- `synthetic-fixture` cannot pass
- `self-reported-runtime` cannot pass
- a captured literal with no artifact loader cannot pass
- a digest mismatch cannot pass
- an unavailable or untrusted independent verifier cannot pass
- a fully loaded, digest-matched, trusted, independently attested artifact can pass

The gate reports the effective evidence level/readiness returned by the shared validator and does not invent a stronger readiness state.

## Security boundary

The verified pilot artifact also preserves the signed-runner boundary:

- all allowed origins must be present in CSP `connect-src`
- sandbox remains exactly `allow-scripts`
- COOP remains `same-origin`
- COEP remains `require-corp`
- at least one non-Coordinator/CDN attempt is observed as blocked
- any unblocked non-allowed origin fails the gate

## Next bottleneck

A clean verified provider pilot reports:

`publisher-tax-filing-production-exception-archive-dr-provider-production-readiness`

That follow-up should turn the verified pilot into a production-readiness decision: recurring verified provider evidence, provider/account approval, production restore windows, alerting/error budget, credential and key rotation, provider outage/failover policy, operator approval, and rollback/hold criteria. It must not treat one successful verified pilot as production approval by itself.
