# Publisher tax production exception audit archive / retention

Issue #118 adds the contract gate that follows the production exception resolution audit.

> This remains a contract/evidence gate. A passing fixture does not prove that a real compliance archive, tax provider, or operator retention system stored evidence in production.

## Position in the gate chain

```text
production exception operations runbook
  -> production exception resolution audit   #116
  -> audit archive / retention                #118
  -> archive restore / integrity drill        next bottleneck
```

Implementation:

- `src/workers-coordinator-publisher-tax-production-exception-audit-archive-retention.ts`
- `tests/workers-coordinator-publisher-tax-production-exception-audit-archive-retention.test.ts`

## Archive package

A clean upstream resolution audit is converted into exactly one versioned archive package.
The package captures the immutable identity set instead of copying mutable display state.

The identity includes:

- action resolution IDs
- runbook action IDs
- provider correction outcome IDs
- support escalation IDs
- terminal publisher status update IDs
- immutable identity audit record IDs and fingerprints
- affected provider filing IDs
- production callback IDs
- replay IDs
- duplicate-filing suppression IDs
- rollback / emergency-hold decision identity

`createWorkersCoordinatorPublisherTaxProductionExceptionArchivePackage()` builds the package from the upstream report and computes its content digest.

## SHA-256 content digest

`computeWorkersCoordinatorPublisherTaxProductionExceptionArchiveDigest()` canonicalizes the archive package and uses Web Crypto SHA-256.

The gate recomputes the digest and requires the same digest on:

1. the archive package
2. archive export evidence
3. every retrieval proof

A rewritten identity therefore cannot be hidden by leaving the old digest in place.

The digest verifies the contract package contents. Production archival still needs durable object-storage controls, access logging, backup/restore evidence, and independent artifact verification.

## Export evidence

Archive export evidence records:

- stable archive ID
- archive locator
- storage class (`immutable-object` or `compliance-archive`)
- retention policy ID
- export timestamp
- content digest

The export must happen after package creation and no later than evidence capture.

## Retrieval proof

Retrievability is an acceptance condition, not an operational assumption.

The evidence must contain exactly one proof for:

- the archive ID itself
- every affected provider filing ID

Each proof must resolve to the same archive ID and content digest and must be observed after export.

This catches archives that were nominally exported but cannot be located through the identifiers operators and publisher support actually have.

## Retention policy

The retention policy contains:

- policy ID
- minimum retention duration
- retention start and end timestamps
- legal hold state
- operational hold state
- deletion eligibility
- explicit deletion-review record

The configured retention duration must be at least the declared minimum.

If any resolution is `carried-forward`, retention must extend beyond the latest `nextReviewAtMs`. The deletion-review record must remain `retain` and schedule its next review no earlier than that carried-forward obligation.

## Hold and deletion semantics

Legal hold or operational hold always disables deletion eligibility.

For a package to be deletion-eligible, all of the following must hold:

- no action is carried forward
- no legal hold applies
- no operational hold applies
- capture time is at or after retention end
- the deletion review explicitly says `eligible-after-retention`
- there is no future deletion-review timestamp

The gate never performs deletion. It validates the evidence saying whether deletion is eligible.
Physical deletion, tombstone/receipt generation, and provider/compliance erase workflows are intentionally outside this gate.

## Security boundary

Archive verification preserves the existing signed-runner boundary:

- all allowed origins appear in CSP `connect-src`
- sandbox flags remain exactly `allow-scripts`
- COOP remains `same-origin`
- COEP remains `require-corp`
- a blocked non-Coordinator/CDN attempt is demonstrated
- an unblocked non-allowlisted network attempt fails the gate

## Report

`WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport` includes:

- full upstream resolution audit evidence
- archive package and SHA-256 digest
- archive export evidence
- retention policy and deletion review
- retrieval proofs
- affected provider / resolution / carry-forward counts
- retention duration and deletion eligibility
- security-boundary state
- `failureReason`
- `bottlenecksToIssue`

A clean report points to:

```text
publisher-tax-filing-production-exception-archive-restore-drill
```

That follow-up should prove archive restoration from the persisted artifact, periodic integrity verification, lost/corrupt archive detection, access/audit logging, and recovery from backup without changing the archived identity set.

## Validation

Focused:

```bash
cd LLM-proto
npm run test:workers-publisher-tax-production-exception-archive
```

Repository-wide:

```bash
npx tsc --noEmit
npm test
```

The focused tests cover the clean path plus upstream failure, archive identity rewriting, digest mismatch, missing provider retrieval proof, retention ending before carry-forward review, deletion while held, premature deletion eligibility, export digest mismatch, duplicate retrieval IDs, and network leakage.
