# Publisher tax production exception archive restore / integrity drill

Issue #121 adds the recoverability gate after the exception archive / retention gate.

> This remains a contract/evidence gate. A passing fixture does not prove that a real archival provider or backup system restored production evidence.

## Position in the gate chain

```text
production exception resolution audit
  -> archive / retention gate                    #118
  -> archive restore / integrity drill           #121
  -> archive disaster-recovery operations        next bottleneck
```

Implementation:

- `src/workers-coordinator-publisher-tax-production-exception-archive-restore-drill.ts`

Focused validation:

```bash
cd LLM-proto
npm run test:workers-publisher-tax-production-exception-archive-restore
```

## Restore paths

The drill supports two explicit paths:

1. `primaryAvailability = available`
   - restore must use `primary-archive`
   - no backup recovery record is expected
2. `primaryAvailability = missing | corrupt`
   - restore must use `backup-replica`
   - a backup recovery record is required
   - backup archive ID, identity set, and digest must exactly match the upstream archive

The restored package is not trusted by declaration alone. The gate recomputes the canonical SHA-256 digest from the restored package and compares it with the archive-retention report.

## Integrity checks

At least one successful integrity check must:

- target the same archive ID
- identify its verifier
- preserve expected and observed digest
- report `match`
- run at or after the restore completes
- be captured before the drill evidence timestamp

A mismatch or only stale pre-restore checks holds the gate.

## Access audit

Successful access-audit records are required for:

- `restore`
- `integrity-check`
- `backup-recovery` when a backup is used

Each record carries actor, purpose, timestamp, archive ID, operation, and result.

## Retention and deletion state

The restore drill carries a retention-policy snapshot and requires it to exactly match the upstream archive-retention report. The drill therefore cannot:

- shorten retention
- clear legal or operational hold
- make a previously ineligible archive deletion-eligible
- rewrite the deletion-review decision

The drill never performs deletion.

## Security boundary

The same signed-runner boundary remains required:

- allowed origins appear in CSP `connect-src`
- sandbox remains exactly `allow-scripts`
- COOP remains `same-origin`
- COEP remains `require-corp`
- at least one non-Coordinator/CDN attempt is shown blocked
- any unblocked non-allowlisted attempt fails the gate

## Next bottleneck

A clean drill points to:

```text
publisher-tax-filing-production-exception-archive-disaster-recovery-operations
```

That follow-up should turn the one-shot restore drill into recurring disaster-recovery operations: scheduled restore cadence, RTO/RPO evidence, backup age/replication lag thresholds, incident escalation, recovery ownership, and production-grade archival provider evidence.
