# Publisher tax exception archive DR provider steady-state operations

Issue #135 adds the recurring production-operations gate after the bounded post-cutover reconciliation gate.

This is still an evidence/decision gate. A passing contract fixture does **not** prove that a real archival provider has been operated continuously in production. A real steady-state claim requires externally captured artifacts that pass the shared artifact loader, SHA-256, trusted-verifier, and independent-attestation path.

## Chain position

```text
provider production cutover
  → post-cutover reconciliation
  → steady-state operations (#135)
  → continuous-assurance automation
```

The post-cutover gate proves one bounded observation window. The steady-state gate requires multiple independently verified recurring cycles and checks that the same controls continue to hold over time.

## Evidence contract

The gate consumes:

- the passing post-cutover reconciliation report;
- the exact `reconciliationInputEvidence` used by that report;
- at least three distinct recurring steady-state cycle `EvidenceEnvelope`s;
- one steady-state operations `EvidenceEnvelope` containing the aggregate schedule/policy state.

Both cycle evidence and the aggregate operations evidence must resolve to effective `captured-and-verified` / `production-approved`. A hand-written `production-approved` literal is insufficient without artifact loading and independent verification.

The exact upstream reconciliation envelope is compared byte-for-JSON with the snapshot preserved in the upstream report. Reusing the same run ID with a different payload is rejected.

## Recurring schedule

A clean result requires:

- at least three distinct verified cycle run IDs;
- one immutable schedule ID;
- a positive cadence and explicit grace window;
- each cycle to begin within its scheduled grace window;
- adjacent scheduled timestamps to advance by exactly one cadence;
- `lastSuccessfulCycleAtMs` to equal the most recent verified completion;
- `nextDueAtMs` to equal the next scheduled period;
- the aggregate capture not to be overdue beyond the next due time plus grace.

A missed period is a hold; later success does not erase the schedule gap.

## Archive integrity every cycle

Every cycle independently re-retrieves the canonical archive from **both** primary and backup storage. Each retrieval must preserve:

- storage identity;
- archive ID;
- canonical content digest;
- retrieval operation ID;
- integrity-check ID and passing result;
- timestamps inside the cycle window.

A successful primary retrieval cannot compensate for a broken backup path.

## Provider audit continuity

Each cycle carries a provider audit stream ID, start cursor, end cursor, and multiple unique audit record IDs.

For adjacent cycles:

- the audit stream ID must remain unchanged;
- the next cycle's start cursor must equal the previous cycle's end cursor.

This prevents a sequence of individually valid but disconnected audit snapshots from being presented as one continuous production history.

## Rolling SLO / error budget

The aggregate report is recomputed from the verified cycles. It checks:

- total operation count;
- total failure count;
- RTO breach count;
- RPO breach count;
- integrity failure count;
- minimum observed provider availability;
- minimum operation volume;
- allowed and remaining failure budget.

RTO/RPO/integrity breaches are fail-closed. The remaining failure budget must equal `allowed - failures` and remain positive.

## Credential and key rotation

The gate starts from the credential/signing/encryption-key identity and rotation deadline that were approved in the upstream production-readiness chain.

A cycle without a rotation event must keep the currently approved identities. Crossing a rotation deadline without explicit rotation evidence is a hold. A rotation event must bind old IDs, new IDs, rotation evidence ID, and rotation time; unexplained key drift is rejected.

The aggregate state records the current credential/key identities and the set of accepted rotation evidence IDs.

## DR / failover exercise cadence

Steady-state operations also require recurring DR exercise evidence:

- positive drill cadence and grace;
- no gap beyond cadence + grace;
- passing recovery integrity;
- recovery point not after exercise start;
- at least one verified exercise that actually uses the backup storage path;
- exact last-exercise and next-due timestamps.

A policy document alone is insufficient; a backup-source exercise must appear in verified cycle evidence.

## Alert, incident, and control review

Per cycle:

- critical alerts must be resolved;
- alert IDs and disposition IDs must be unique/traceable;
- active Sev1/Sev2 incidents hold the gate;
- rollback and emergency-hold controls must remain armed;
- control invocation IDs must reference the immutable approved control IDs;
- every invocation requires reconciliation;
- an active invocation remains a hold.

## Operational evidence retention

Each verified cycle must also retain its own operational evidence artifact. The cycle records:

- evidence archive ID;
- evidence content digest;
- retrieval proof ID;
- retention-until timestamp.

The retained digest must equal the SHA-256 of the independently verified cycle artifact, and retention must extend at least the configured minimum horizon beyond capture.

## Preserved boundaries

Across the aggregate and every cycle, the gate preserves:

- provider/account/primary/backup/replica/archive identity;
- baseline incident identity;
- recovery owner, on-call route, and escalation target;
- archive retention/legal/operational-hold/deletion-review state;
- rollback/emergency-hold control IDs;
- Coordinator/CDN allowlist;
- CSP connect-src;
- sandbox = `allow-scripts` only;
- COOP `same-origin`;
- COEP `require-corp`;
- a blocked negative non-Coordinator/CDN network attempt.

Any unblocked third-party network attempt holds the gate.

## Focused validation

```bash
cd LLM-proto
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-steady-state-operations
```

The full suite remains authoritative:

```bash
npx tsc --noEmit
npm test
```

## Next bottleneck

A clean steady-state report points to:

`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-automation`

The reason for a separate next step is deliberate: this gate validates supplied recurring evidence, but it does not itself schedule provider reconciliations, trigger archive retrievals/DR drills/key rotations, collect provider artifacts, or page operators when a cycle becomes overdue. Continuous-assurance automation should own that orchestration while continuing to feed independently verifiable evidence into these gates.
