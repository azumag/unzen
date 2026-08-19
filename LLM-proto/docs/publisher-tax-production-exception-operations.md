# Publisher tax production exception operations runbook

Issue #91 adds the contract gate that follows publisher tax production monitoring reconciliation.

> This is still a contract/evidence gate. A passing fixture does not prove that a real tax provider, support team, or publisher notification system performed these operations in production.

## Position in the gate chain

```text
production callbacks readiness
  -> production monitoring reconciliation
  -> production exception operations runbook   #91
  -> production exception resolution audit     next bottleneck
```

The upstream monitoring gate already reconciles accepted, rejected, corrected, and duplicate-suppressed callback streams into operator monitoring records, publisher monitoring exports, alert traceability, replay controls, duplicate-filing suppression, and rollback/emergency-hold controls.

The exception operations gate turns the actionable subset into operator-facing and publisher-facing evidence rather than treating monitoring as the end of the workflow.

## Inputs

`runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate()` accepts:

- a passing `WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport`
- `WorkersCoordinatorPublisherTaxProductionExceptionOperationsEvidence`

The runbook evidence contains:

- replay detections captured by the exception-operations surface
- operator runbook actions
- support escalation records
- publisher-facing filing status updates
- preserved duplicate-filing suppression IDs
- one rollback/emergency-hold decision record
- CSP / sandbox / COOP / COEP and network-boundary evidence

### Replay detections

The current monitoring reconciliation report exposes the replay audit count but not replay IDs. The exception-operations capture therefore records replay detections explicitly:

```ts
interface WorkersCoordinatorPublisherTaxProductionReplayDetection {
  replayId: string;
  sourceCallbackIds: readonly string[];
  detectedAtMs: number;
}
```

The gate fails closed when the captured replay count differs from upstream `replayAuditCount`, a replay ID is duplicated, a replay references an unknown production callback, or the timestamp is invalid. This avoids inventing replay identifiers in the upstream report while still binding runbook actions to observed callback IDs.

## Required runbook actions

The gate derives one action requirement for each of these events:

| Event | Required action |
|---|---|
| `filing.rejected` | `investigate-rejection` |
| `filing.corrected` | `prepare-correction` |
| `filing.duplicate_suppressed` | `confirm-duplicate-suppression` |
| `monitoring.replay_detected` | `review-replay` |

Each action must preserve the relevant monitoring record IDs, monitoring alert IDs, provider filing IDs, production callback or replay identity, and approved production filing window ID.

## Support escalation traceability

Every required runbook action must have a support escalation record. The escalation is validated against:

- action ID
- monitoring alert IDs
- production callback IDs
- provider filing IDs
- approved production filing window ID
- positive `openedAtMs`

A corrected callback may legitimately have no monitoring alert; in that case the empty alert set is preserved rather than fabricating an alert ID.

## Publisher status updates

Every provider filing affected by an exception or replay must have a publisher-facing status update in the approved filing window. The update must link all relevant runbook action IDs and support escalation IDs for that provider filing.

The contract supports these status values:

- `exception-open`
- `correction-in-progress`
- `duplicate-suppressed`
- `under-review`

## Duplicate filing suppression and control decisions

The gate carries forward all duplicate-filing suppression IDs required by the monitoring reconciliation report. Missing IDs cause a hold.

The rollback/emergency-hold decision must reference the same rollback plan ID and emergency hold switch ID that the upstream monitoring gate preserved from production cutover. The decision can be:

- `continue-monitoring`
- `hold`
- `rollback`

The gate validates linkage and evidence shape; it does not prescribe which decision operators must choose.

## Security boundary

Exception operations preserve the existing signed-runner boundary:

- allowed origins must be included in CSP `connect-src`
- sandbox flags remain exactly `allow-scripts`
- COOP remains `same-origin`
- COEP remains `require-corp`
- at least one non-Coordinator/CDN attempt must be shown blocked
- any unblocked non-allowlisted attempt fails the gate

## Report

`WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport` includes:

- complete production monitoring reconciliation evidence
- replay detections
- operator runbook action IDs and records
- support escalation IDs and records
- publisher status update IDs and records
- exception-operation counts
- approved production window reconciliation
- duplicate-filing suppression state
- rollback/emergency-hold decision evidence
- signed-runner security boundary and blocked non-Coordinator/CDN attempt
- `failureReason`
- `bottlenecksToIssue`

A clean report points at the next issue-worthy bottleneck:

```text
publisher-tax-filing-production-exception-resolution-audit
```

That follow-up should verify that open exception actions are resolved or explicitly carried forward, corrected filings reconcile back to provider outcomes, publisher status transitions reach a terminal/auditable state, and support/operator records remain immutable and traceable.

## Validation

Focused:

```bash
cd LLM-proto
npm run test:workers-publisher-tax-production-exceptions
```

Repository-wide LLM-proto validation:

```bash
npx tsc --noEmit
npm test
```

The focused tests cover the success path and failure cases for upstream failure, missing runbook actions, support escalation traceability, publisher status updates, duplicate-filing suppression, rollback/emergency-hold linkage, replay count mismatch, and network-boundary leakage.
