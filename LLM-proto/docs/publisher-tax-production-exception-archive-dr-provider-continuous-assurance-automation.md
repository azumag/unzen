# Publisher tax production exception archive DR provider continuous assurance automation

Issue #137 extends the steady-state operations gate into a deterministic orchestration contract.

> [!IMPORTANT]
> This module is not a deployed scheduler or a real archival-provider integration. Contract fixtures prove orchestration logic only. Production claims still require externally captured-and-verified provider evidence and a deployed runtime that invokes this tick.

## Implementation

- `src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-automation.ts`

Focused test:

```bash
npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance
```

The automation consumes the exact `production-approved` steady-state evidence and the exact historical cycle EvidenceEnvelopes preserved by #135.

## Deterministic scheduling

The entrypoint receives explicit `nowMs`; it contains no hidden timer.

- before `nextDueAtMs`: return `idle` with no provider or pager callbacks
- inside the due/grace window: execute one deterministic cycle
- after grace: `hold`, page with a deterministic dedupe key, and create no cycle evidence
- already-overdue rotation or DR exercise: fail closed before normal actions

The cycle ID is derived from the schedule ID and scheduled timestamp.

## Executor boundary

`ContinuousAssuranceExecutor` owns provider audit collection, primary/backup archive retrieval, operational health, due key rotation, due backup-source DR exercise, cycle evidence archival, cycle capture, aggregate capture, and operator paging.

Every side effect receives a stable idempotency key:

```text
<cycle-id>:<action-name>
```

Retries reuse that key. Retry count is bounded and backoff is recorded as metadata; the pure module does not sleep internally.

## Evidence and final decision

The sequence is:

1. collect provider/audit/archive/health evidence
2. run due rotation and/or DR exercise
3. archive the cycle evidence and obtain retention/retrieval proof
4. request an external cycle EvidenceEnvelope
5. require effective `captured-and-verified` / `production-approved`
6. append the verified cycle to the historical cycle set
7. request and independently validate the next aggregate EvidenceEnvelope
8. run the existing #135 steady-state operations gate

Self-reported or otherwise unverified capture output is a hold. The orchestrator does not promote literals to verified evidence itself.

The #135 gate remains authoritative for schedule continuity, archive integrity, rolling SLO/error budget, key rotation, DR cadence, alert/incident/control state, evidence retention, and the Coordinator/CDN network boundary.

If an action fails, the original operational failure remains the hold reason. A paging failure is recorded separately and does not replace it.

## Next bottleneck

`publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-worker-runtime`

The next step is a deployed scheduled runtime with durable idempotency and paging state, real provider adapters, crash/replay recovery, and captured runtime evidence. #137 intentionally stops at the deterministic orchestration contract.
