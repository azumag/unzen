# Workers Coordinator Prototype Gate

This gate moves the simulated Coordinator contract toward the Cloudflare Workers
boundary. `src/workers-coordinator-prototype.ts` models the API request endpoint,
Durable Object single-writer state, WebSocket heartbeat upgrade path, Coordinator
checkpoint storage, p95 fan-out latency, and the transport allowlist that a
Workers prototype must preserve.

`src/workers-coordinator-miniflare-smoke.ts` then runs the same boundary through
Miniflare/workerd: `/api/requests` is dispatched as a real Worker fetch,
registration and checkpoint metadata are persisted through Durable Object
storage, `/workers/:workerId/socket` is opened as a real WebSocket upgrade, and
direct worker-to-worker networking is rejected by the Worker route.
The load-shaped smoke keeps that runtime boundary but drives multiple
customer-like API requests, measures client-side WebSocket heartbeat timing,
simulates worker churn, and recreates the Miniflare Worker against the same
Durable Object persistence root to prove storage survives restart/reload.

`src/workers-coordinator-deployed-smoke.ts` lifts that contract to an
authenticated Wrangler preview or deployed Worker URL. The runner is client
injected so CI can verify the deployed smoke contract without Cloudflare secrets,
while a real browser/WebSocket client can supply fetch latency, heartbeat p95,
edge colo observations, and the deployed Worker report when credentials exist.

`src/workers-coordinator-production-observability-canary.ts` consumes the
deployed smoke report as the production release contract. It exports durable
per-request metrics, evaluates alert thresholds for browser WebSocket p95, edge
placement variance, direct worker-to-worker rejection, upstream Worker failure
reason, and retry count, then makes a deterministic canary promote/hold/rollback
decision while proving rollback stays inside the Coordinator-owned checkpoint
boundary.

`src/workers-coordinator-signed-runner-release-gate.ts` starts from a clean
production canary report and validates the signed runner delivery boundary. It
records the runner CSP `connect-src`, sandbox iframe flags, top-level DOM /
Cookie / Storage isolation, COOP / COEP response headers, signature verification,
allowed Coordinator / CDN origins, and a blocked non-Coordinator/CDN network
attempt before release can proceed.

`src/workers-coordinator-signed-runner-browser-preview.ts` takes the same signed
runner boundary through a browser harness against an authenticated Wrangler
preview or deployed Worker URL. It records the target URL and auth preflight,
browser-captured runner headers, CSP `connect-src`, sandbox flags, COOP / COEP,
allowed origins, and blocked non-Coordinator/CDN network attempts before routing
to the next pilot bottleneck. The browser-captured runner URL must stay on the
same URL origin as the configured preview target and, when that target is
path-scoped, must either match the target pathname exactly or remain below it on
a path-segment boundary. Lookalike hostnames, sibling pathname prefixes, and
malformed URLs fail closed as `runner-url-outside-preview-target`. The contract
fields are carried inside an `EvidenceEnvelope` payload: the gate runs
`validateEvidenceEnvelope()` first and only reports readiness from the validator
result. A hand-written fixture that claims `captured-and-verified` is rejected as
`not-evaluated` unless an external artifact loader, independent verifier, and
trusted verifier list are supplied.

`src/workers-coordinator-signed-runner-webgpu-worker-pilot.ts` connects that
preview runner to a WebGPU dedicated worker pilot. The report keeps the preview
runner URL, model segment execution state, IndexedDB segment cache evidence,
Coordinator-owned checkpoint relay evidence, CSP `connect-src`, sandbox flags,
COOP / COEP, allowed origins, and blocked non-Coordinator/CDN network attempts
in one gate while the worker is actively executing a segment. Evidence is
accepted only via a validated `EvidenceEnvelope`, and the reported readiness is
capped by the browser-preview upstream so synthetic evidence cannot be promoted
to production root cause downstream. Despite the gate name, a contract-tested
envelope is reported as `contract-tested`, not as verified execution.

`src/workers-coordinator-webgpu-worker-performance-telemetry.ts` turns the
passing pilot into production decision telemetry. It reports segment latency
distribution, IndexedDB cache hit/miss timing, Coordinator checkpoint relay
duration/retry/failure reasons, WebGPU device loss handling, CPU fallback
routing, and the same signed runner isolation / Coordinator-CDN network boundary
while telemetry collection is active. The telemetry fields are validated through
an `EvidenceEnvelope`, and the reported readiness is capped by the pilot
upstream. `captured-and-verified` is reached only when the artifact loader,
independent verifier, and trusted verifier list are present.

`src/workers-coordinator-production-worker-fleet-slo-cost.ts` aggregates that
single-runner telemetry into a production worker fleet SLO and cost gate. It
reports p95 segment latency by device tier, WebGPU device loss and CPU fallback
rate, IndexedDB cache warmup cost and miss penalty, Coordinator checkpoint relay
spend / retry / failure budget, user opt-in impact, promote/hold thresholds, and
the signed runner isolation / Coordinator-CDN network boundary while fleet
aggregation is active.

`src/workers-coordinator-publisher-reward-settlement.ts` converts passing fleet
SLO / cost evidence into publisher reward accrual inputs. It links each reward
claim to Coordinator-owned checkpoint relay evidence and verified signed runner
execution evidence, detects spoofed workers, replayed checkpoint claims,
duplicate segment contribution claims, and cost-shifting abuse, and preserves
the signed runner isolation / Coordinator-CDN network boundary while settlement
aggregation is active.

`src/workers-coordinator-publisher-ledger-payout-reconciliation.ts` persists
passing settlement decisions into a deterministic pilot ledger. It reconciles
payout batches against reward accrual totals and Coordinator relay spend,
excludes publisher-level holds from payout batches, surfaces publisher/operator
dispute evidence, and preserves the signed runner isolation / Coordinator-CDN
network boundary while ledger reconciliation is active.

`src/workers-coordinator-publisher-payout-dry-run.ts` connects that reconciled
pilot ledger to payout provider dry-run evidence before live money movement. It
reconciles provider dry-run totals against ledger payout batches and Coordinator
relay spend, requires tax / invoice metadata for payable publishers, records
operator dry-run-only approval evidence, surfaces publisher-facing
reconciliation exports, and preserves the signed runner isolation /
Coordinator-CDN network boundary while payout dry-run evidence is collected.

`src/workers-coordinator-publisher-live-money-payout-pilot.ts` executes the
approved payout provider batch behind an operator-controlled release switch. It
reconciles provider settlement callbacks against the dry-run provider batch,
ledger payout totals, and publisher-level holds, captures publisher receipts and
payout status transitions, keeps emergency hold / rollback controls outside the
signed runner boundary, and preserves the signed runner isolation /
Coordinator-CDN network boundary while live payout evidence is collected.

`src/workers-coordinator-publisher-recurring-payout-operations.ts` turns the
controlled live-money payout pilot into recurring payout operations. It validates
idempotent scheduled payout windows, provider retry/backoff ledgers across
settled, pending, failed, and delayed callbacks, publisher support dispute
routing, accounting export reconciliation, post-pilot SLO/error-budget
dashboards, emergency hold / rollback controls outside the signed runner
boundary, and the same Coordinator-CDN network allowlist during recurring payout
operations.

`src/workers-coordinator-publisher-revenue-reporting.ts` turns recurring payout
operations into payout operations revenue reporting. It validates
publisher-facing monthly statements that link recurring payout windows, ledger
entries, receipts, disputes, and provider payout IDs, reconciles platform fee
revenue and Coordinator relay spend margin against accounting exports and
provider settlements, appends refund / reversal / clawback adjustments without
mutating immutable payout ledger history, emits audit-ready finance and operator
exports, keeps emergency hold / rollback controls outside the signed runner
boundary, and preserves the same Coordinator-CDN network allowlist during
revenue reporting.

`src/workers-coordinator-publisher-tax-reporting.ts` turns payout operations
revenue reporting into tax reporting and 1099-K export readiness. It validates
payable publisher tax profiles, tax-year publisher summaries, 1099-K export
records, revenue reporting / accounting export reconciliation, finance and
operator review exports, emergency hold / rollback controls outside the signed
runner boundary, and the same Coordinator-CDN network allowlist during tax
reporting.

`src/workers-coordinator-publisher-tax-filing-delivery.ts` turns tax reporting
readiness into an end-to-end tax filing drill and publisher delivery workflow.
It validates provider filing packet handoff for generated 1099-K records,
accepted and rejected filing attempts, retry evidence, publisher portal document
delivery with acknowledgement and download evidence, corrected-form workflow for
post-filing refund / reversal / clawback adjustments, filing deadline alerts,
post-filing audit evidence, emergency hold / rollback controls outside the
signed runner boundary, and the same Coordinator-CDN network allowlist during
tax filing delivery.

`src/workers-coordinator-publisher-tax-provider-sandbox-filing.ts` turns the tax
filing delivery drill into a real provider sandbox filing run. It validates
sandbox provider request and response IDs, accepted and rejected submission
states, signed provider callbacks, publisher delivery evidence linked to sandbox
provider IDs, corrected-form and post-filing audit reconciliation, emergency
hold / rollback controls outside the signed runner boundary, and the same
Coordinator-CDN network allowlist during provider sandbox filing.

`src/workers-coordinator-publisher-tax-production-cutover-readiness.ts` turns the
provider sandbox filing run into production filing cutover readiness. It
validates sandbox provider filing IDs, operator approval evidence, production
filing window metadata, live-provider preflight evidence without moving money or
submitting duplicate forms, duplicate-filing suppression, preserved accepted and
rejected sandbox evidence, rollback / emergency hold controls before production
callbacks are enabled, and the same Coordinator-CDN network allowlist during
production cutover readiness.

`src/workers-coordinator-publisher-tax-production-callbacks-readiness.ts` turns
the production cutover readiness report into production callbacks readiness. It
validates signed production callback IDs, cutover approval linkage, approved
production filing window reconciliation, sandbox provider filing ID linkage,
duplicate-filing suppression, rollback / emergency hold controls during
callback ingestion, and the same Coordinator-CDN network allowlist during
production callbacks readiness.

`src/workers-coordinator-publisher-tax-production-monitoring-reconciliation.ts`
turns passing production callbacks readiness into production monitoring
reconciliation. It reconciles accepted, rejected, corrected, and
duplicate-suppressed callback streams into operator monitoring records,
publisher monitoring exports, alert traceability, duplicate-filing suppression
replay, rollback / emergency hold replay controls, and the same Coordinator-CDN
network allowlist during production monitoring reconciliation.

The harness intentionally reuses `AdaptiveChunkDispatcher` assignment reports
instead of inventing a second scheduler. This keeps the report fields stable
while validating the Workers-specific boundary.

Imported `checkpointTransferMs` values are validated before any simulated
Coordinator/CDN connection is recorded. Finite values must be exact,
non-negative safe integers and are summed with checked arithmetic; if the total
would leave JavaScript's safe-integer range, the run fails closed instead of
rounding through precision loss. `AdaptiveChunkDispatcher` may use
`Number.POSITIVE_INFINITY` internally as an unbounded-transfer sentinel, but
Workers Coordinator reports reject that sentinel at the runtime boundary so all
reported timing fields remain finite and JSON-safe.

Derived timing is also computed with checked safe-integer arithmetic before any
simulated transport activity. Retry/resume delay rejects overflow in
`checkpointRelayMs + retryBackoffMs`; request completion rejects overflow while
adding `receivedAtMs`, fan-out latency, and retry delay; heartbeat fan-out
samples reject timestamps that predate the request or would overflow when the
per-worker scheduling offset is added.

## Prototype Contract

| Boundary | Prototype expectation |
|---|---|
| API request endpoint | Accepts a request and emits `requestLifecycle` with endpoint, accepted time, planned segment count, prompt tokens, and completed time. |
| Worker registry | Stores registration, heartbeat time, eligibility, and max chunk length in a Durable Object-like single-writer state owner. |
| WebSocket heartbeat path | Reports the upgrade endpoint, processed heartbeat count, fan-out latency samples, and p95 latency. |
| Assignment import | Carries `AdaptiveChunkDispatcher` assignment fields through `assignmentReport.assignments`. |
| Checkpoint relay | Uses Coordinator-owned storage keys and `directWorkerNetworking: false`; no worker-to-worker channel exists. |
| Worker loss | Emits `retryResumeImpact` with lost worker, retry count, resume count, estimated delay, and resume segment. |
| Network boundary | Allows only Coordinator and CDN origins; direct worker-to-worker URLs are rejected by test and reported as rejected. |

## Miniflare Runtime Smoke

The focused runtime smoke uses Miniflare instead of an in-memory Durable Object
stand-in. The test imports an `AdaptiveChunkDispatcher` assignment report, posts
the manifest to `/api/requests`, opens concurrent heartbeat WebSockets for all
registered workers, stores checkpoint relay metadata under Coordinator-owned
Durable Object keys, and records the 403 rejection from `/worker-peer/direct`.

Before the manifest crosses the host-to-Miniflare JSON boundary, every imported
`checkpointTransferMs` must be a non-negative safe integer and the aggregate
must remain in JavaScript's safe-integer range. This deliberately rejects the
dispatcher's internal `Infinity` sentinel before `JSON.stringify()` can coerce
it to `null` and change the meaning of the runtime evidence. The same preflight
runs across every manifest in the load-shaped smoke before Miniflare activity.

The Miniflare boundary also validates `receivedAtMs`, checkpoint relay/backoff
timings, latency thresholds, worker heartbeat timestamps, and retry/resume
derived timing before runtime startup. The normal smoke additionally preflights
the full synthetic heartbeat schedule so its generated `sentAtMs` and fan-out
samples cannot leave JavaScript's safe-integer range after a request has already
been accepted. The embedded Durable Object runtime repeats the manifest timing
validation after JSON parsing and uses checked arithmetic for retry/resume delay
and `requestLifecycle.completedAtMs`; this keeps direct runtime use fail-closed
even if host-side callers change later. Load-shaped heartbeat count and its
explicit p95 budget are validated before Miniflare startup as well.

Each caller-owned manifest is then serialized exactly once into the JSON body
that will cross the Miniflare boundary, parsed back into an owned snapshot, and
validated again. Request IDs, workers, heartbeat scheduling, report lookups, and
load-shaped restart/persistence checks all use that owned snapshot rather than
re-reading caller-controlled getters or objects after asynchronous work starts.
This binds host-side validation, the transmitted request body, and subsequent
runtime evidence to one manifest generation.

`WorkersCoordinatorMiniflareSmokeReport` includes:

- `runtime`
- `requestLifecycle`
- `durableObjectStorageFields`
- `assignmentReport`
- `checkpointRelay`
- `retryResumeImpact`
- `webSocketHeartbeatPath`
- `directWorkerNetworking`
- `fanoutLatencyMs`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorLoadShapedSmokeReport` includes:

- `customerTraffic`
- `clientTiming`
- `restartPersistence`
- `requestReports`
- `directWorkerNetworking`
- `retryResumeImpact`
- `failureReason`

`WorkersCoordinatorDeployedSmokeReport` includes:

- `target`
- `requestLifecycle`
- `browserWebSocketTiming`
- `edgePlacement`
- `directWorkerNetworking`
- `upstreamReport`
- `bottlenecksToIssue`
- `failureReason`

The deployed smoke owns a stable request boundary before asynchronous client
activity. The caller manifest is JSON-snapshotted, deployment target fields are
copied once, numeric heartbeat/latency controls are preflighted, and derived
heartbeat counts use checked safe-integer multiplication. Request and heartbeat
latencies must remain finite and non-negative; heartbeat acknowledgements must
match the expected worker, request, and burst; and the upstream report must
match the snapshotted request ID. This keeps deployed evidence bound to one
manifest/target generation and prevents malformed `NaN`/infinite telemetry from
silently bypassing latency gates.

`WorkersCoordinatorProductionObservabilityCanaryReport` includes:

- `metricsExport`
- `alertThresholds`
- `canaryRelease`
- `rollbackCheckpointBoundary`
- `bottlenecksToIssue`
- `failureReason`

The production observability gate validates numeric policy and observed metrics
before alert evaluation. Latency thresholds and observed latency/variance must
be non-negative finite numbers, retry/canary counters and `exportedAtMs` must be
non-negative safe integers, and `sampleRate` must be finite within `[0, 1]`.
This prevents JavaScript `NaN`/infinite comparisons from becoming accidental
clean alerts or promotion decisions.

`WorkersCoordinatorSignedRunnerReleaseGateReport` includes:

- `csp`
- `sandboxIframe`
- `coopCoepHeaders`
- `signature`
- `networkBoundary`
- `bottlenecksToIssue`
- `failureReason`

The signed-runner release gate snapshots both the upstream production-gate
report and the runner contract through JSON before evaluating CSP, sandbox,
headers, signature, or observed network attempts. Network-attempt URL
classification and the URL retained in the gate report therefore come from the
same owned generation instead of re-reading caller-controlled getters during
classification.

`WorkersCoordinatorSignedRunnerBrowserPreviewReport` includes:

- `target`
- `browserHarness`
- `releaseGateReport`
- `allowedOrigins`
- `blockedNonCoordinatorCdnNetworkAttempt`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport` includes:

- `previewRunnerUrl`
- `segmentExecution`
- `indexedDbCache`
- `checkpointRelay`
- `securityBoundaryDuringExecution`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorWebGpuWorkerPerformanceTelemetryReport` includes:

- `previewRunnerUrl`
- `segmentLatencyDistribution`
- `indexedDbCacheTiming`
- `checkpointRelayTiming`
- `webGpuDeviceLoss`
- `cpuFallbackRouting`
- `securityBoundaryDuringTelemetry`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorProductionWorkerFleetSloCostReport` includes:

- `previewRunnerUrl`
- `deviceTierP95Latency`
- `fallbackBudget`
- `cacheWarmupCost`
- `checkpointRelaySpend`
- `userOptInImpact`
- `promoteHoldThresholds`
- `securityBoundaryDuringFleetAggregation`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorPublisherRewardSettlementReport` includes:

- `previewRunnerUrl`
- `rewardAccrualInputs`
- `checkpointRelayEvidence`
- `signedRunnerExecutionLinkage`
- `abuseDetectionResults`
- `publisherSettlementHoldReasons`
- `settlementBudget`
- `promoteHoldThresholds`
- `securityBoundaryDuringSettlement`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorPublisherPilotLedgerReport` includes:

- `previewRunnerUrl`
- `ledgerEntries`
- `payoutBatchReconciliation`
- `rewardAccrualTotals`
- `disputeEvidence`
- `settlementHoldReasons`
- `promoteHoldThresholds`
- `securityBoundaryDuringLedgerReconciliation`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorPublisherPayoutDryRunReport` includes:

- `previewRunnerUrl`
- `payoutProviderDryRunEvidence`
- `payoutDryRunReconciliation`
- `taxInvoiceMetadata`
- `operatorApprovalEvidence`
- `publisherFacingReconciliationExports`
- `promoteHoldThresholds`
- `securityBoundaryDuringPayoutDryRun`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorPublisherLiveMoneyPayoutPilotReport` includes:

- `previewRunnerUrl`
- `operatorReleaseSwitchEvidence`
- `providerSettlementCallbacks`
- `livePayoutReconciliation`
- `publisherReceiptEvidence`
- `payoutStatusTransitions`
- `emergencyHoldRollbackControls`
- `promoteHoldThresholds`
- `securityBoundaryDuringLivePayout`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorPublisherRecurringPayoutOperationsReport` includes:

- `previewRunnerUrl`
- `scheduledPayoutWindowIdempotency`
- `providerRetryBackoffLedgers`
- `publisherSupportDisputeRouting`
- `accountingExportReconciliation`
- `postPilotSloErrorBudgetDashboards`
- `emergencyHoldRollbackControls`
- `recurringPayoutReconciliation`
- `promoteHoldThresholds`
- `securityBoundaryDuringRecurringOperations`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorPublisherRevenueReportingReport` includes:

- `previewRunnerUrl`
- `publisherMonthlyStatements`
- `platformFeeRelaySpendMarginReconciliation`
- `refundReversalClawbackAdjustments`
- `auditReadyPayoutOperationsExports`
- `emergencyHoldRollbackControls`
- `revenueReportingSummary`
- `promoteHoldThresholds`
- `securityBoundaryDuringRevenueReporting`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorPublisherTaxReportingReport` includes:

- `previewRunnerUrl`
- `publisherTaxProfiles`
- `taxYearPublisherSummaries`
- `tax1099KExportRecords`
- `taxExportReconciliation`
- `financeOperatorReviewExports`
- `taxHolds`
- `emergencyHoldRollbackControls`
- `taxReportingSummary`
- `promoteHoldThresholds`
- `securityBoundaryDuringTaxReporting`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorPublisherTaxFilingDeliveryReport` includes:

- `previewRunnerUrl`
- `providerFilingPackets`
- `publisherDocumentDeliveries`
- `correctedFormWorkflows`
- `filingDeadlineAlerts`
- `postFilingAuditEvidence`
- `emergencyHoldRollbackControls`
- `taxFilingDeliverySummary`
- `promoteHoldThresholds`
- `securityBoundaryDuringTaxFilingDelivery`
- `bottlenecksToIssue`
- `failureReason`

`WorkersCoordinatorPublisherTaxProviderSandboxFilingReport` includes:

- `previewRunnerUrl`
- `sandboxRuns`
- `sandboxReconciliations`
- `taxExportRecordIds`
- `accountingExportIds`
- `correctedFormWorkflowIds`
- `emergencyControlIds`
- `sandboxFilingSummary`
- `promoteHoldThresholds`
- `securityBoundaryDuringProviderSandboxFiling`
- `bottlenecksToIssue`
- `failureReason`

## Report Fields

`WorkersCoordinatorPrototypeReport` includes:

- `requestLifecycle`
- `workerStateBoundary`
- `assignmentReport`
- `checkpointRelay`
- `retryResumeImpact`
- `webSocketHeartbeatPath`
- `directWorkerNetworking`
- `fanoutLatencyMs`
- `bottlenecksToIssue`
- `transport`
- `failureReason`

The gate fails when no worker remains eligible, WebSocket heartbeat p95 fan-out
latency exceeds the configured threshold, or retry/resume impact exceeds the
scale-up threshold.

## Focused Test Command

```bash
cd LLM-proto
npm test -- --run tests/workers-coordinator-prototype.test.ts
npm run test:workers-smoke
npm run test:workers-load-smoke
npm run test:workers-deployed-smoke
npm run test:workers-production-gate
npm run test:workers-signed-runner-gate
npm run test:workers-signed-runner-browser-preview
npm run test:workers-signed-runner-webgpu-worker-pilot
npm run test:workers-webgpu-telemetry
npm run test:workers-fleet-slo-cost
npm run test:workers-publisher-settlement
npm run test:workers-publisher-ledger
npm run test:workers-publisher-payout-dry-run
npm run test:workers-publisher-live-payout
npm run test:workers-publisher-recurring-payout
npm run test:workers-publisher-revenue-reporting
npm run test:workers-publisher-tax-reporting
npm run test:workers-publisher-tax-filing-delivery
npm run test:workers-publisher-tax-provider-sandbox
npm run test:workers-publisher-tax-production-cutover
npm run test:workers-publisher-tax-production-callbacks
npm run test:workers-publisher-tax-production-monitoring
```

The full report gate remains:

```bash
cd LLM-proto
npm test -- --run
```

## Next Bottleneck

`WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport` includes:

- `sandboxProviderFilingIds`
- `operatorApprovalEvidence`
- `productionFilingWindow`
- `liveProviderPreflightEvidence`
- `preservedSandboxEvidence`
- `productionCutoverSummary`
- `promoteHoldThresholds`
- `securityBoundaryDuringProductionCutover`
- `failureReason`
- `bottlenecksToIssue`

`WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport` includes:

- `cutoverApprovalEvidence`
- `productionFilingWindow`
- `productionProviderCallbacks`
- `productionCallbacksSummary`
- `promoteHoldThresholds`
- `securityBoundaryDuringProductionCallbacks`
- `failureReason`
- `bottlenecksToIssue`

`WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport` includes:

- `cutoverApprovalEvidence`
- `productionProviderCallbacks`
- `operatorMonitoringRecords`
- `publisherMonitoringExports`
- `monitoringAlerts`
- `productionMonitoringSummary`
- `approvedWindowReconciliation`
- `duplicateFilingSuppressionReplay`
- `rollbackEmergencyControlsDuringReplay`
- `promoteHoldThresholds`
- `securityBoundaryDuringProductionMonitoring`
- `failureReason`
- `bottlenecksToIssue`

If the publisher tax filing production monitoring reconciliation gate passes,
the next issue should add the production exception operations runbook: convert
rejected, corrected, duplicate-suppressed, and replay-detected monitoring events
into operator runbook actions, support escalation records, publisher-facing
status updates, and rollback / emergency hold decision evidence.
