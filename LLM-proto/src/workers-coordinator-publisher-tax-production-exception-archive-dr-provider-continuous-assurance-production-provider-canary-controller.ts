import {
  createContinuousAssuranceServiceBindingExecutor,
  type ContinuousAssuranceServiceBinding,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.js';
import type {
  ContinuousAssuranceActionContext,
  ContinuousAssuranceHealthResult,
  ContinuousAssuranceProviderAuditResult,
  ContinuousAssurancePageRequest,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-automation.js';
import type { SteadyStateArchiveRetrieval } from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.js';
import type {
  ProductionProviderCanaryAuthorization,
  ProductionProviderCanaryReceipt,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.js';

export interface ProductionProviderCanaryBindings {
  readonly provider: ContinuousAssuranceServiceBinding;
  readonly pager: ContinuousAssuranceServiceBinding;
}

export interface ProductionProviderCanaryExecutionOptions {
  readonly canaryRunId: string;
  readonly authorization: ProductionProviderCanaryAuthorization;
  readonly nowMs: number;
  readonly bindings: ProductionProviderCanaryBindings;
  readonly onCallRoute: string;
  readonly escalationTarget: string;
}

export interface ProductionProviderCanaryExecutionResult {
  readonly canaryRunId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly receipts: readonly ProductionProviderCanaryReceipt[];
}

const REQUIRED_ACTIONS = [
  'provider-health',
  'provider-audit',
  'primary-archive-retrieval',
  'backup-archive-retrieval',
  'pager-canary',
] as const;

export async function executeProductionProviderCanary(
  options: ProductionProviderCanaryExecutionOptions,
): Promise<ProductionProviderCanaryExecutionResult> {
  preflight(options);
  const executor = createContinuousAssuranceServiceBindingExecutor({
    provider: options.bindings.provider,
    evidence: rejectBinding('evidence'),
    pager: options.bindings.pager,
  });
  const receipts: ProductionProviderCanaryReceipt[] = [];
  let observedAtMs = options.nowMs;

  const context = (action: ContinuousAssuranceActionContext['action']): ContinuousAssuranceActionContext => ({
    cycleId: options.canaryRunId,
    scheduledAtMs: options.authorization.startsAtMs,
    nowMs: options.nowMs,
    action,
    idempotencyKey: `${options.canaryRunId}:${action}`,
    attempt: 1,
    backoffMsBeforeAttempt: 0,
  });

  const healthContext = context('operational-health');
  const health = await executor.collectOperationalHealth(healthContext);
  receipts.push(providerReceipt(
    'provider-health',
    healthContext.idempotencyKey,
    providerOperationId(health, 'providerHealthOperationId', 'provider-health-operation-id-missing'),
    ++observedAtMs,
    options.authorization,
  ));

  const auditContext = context('provider-audit');
  const audit = await executor.collectProviderAudit(auditContext);
  receipts.push(providerReceipt(
    'provider-audit',
    auditContext.idempotencyKey,
    audit.auditStreamId,
    ++observedAtMs,
    options.authorization,
  ));

  const primaryContext = context('primary-archive-retrieval');
  const primary = await executor.retrieveArchive(
    'primary',
    options.authorization.primaryStorageId,
    options.authorization.archiveId,
    options.authorization.archiveContentDigest,
    primaryContext,
  );
  receipts.push(retrievalReceipt(
    'primary-archive-retrieval',
    primaryContext.idempotencyKey,
    primary,
    ++observedAtMs,
    options.authorization,
  ));

  const backupContext = context('backup-archive-retrieval');
  const backup = await executor.retrieveArchive(
    'backup',
    options.authorization.backupStorageId,
    options.authorization.archiveId,
    options.authorization.archiveContentDigest,
    backupContext,
  );
  receipts.push(retrievalReceipt(
    'backup-archive-retrieval',
    backupContext.idempotencyKey,
    backup,
    ++observedAtMs,
    options.authorization,
  ));

  const pagerKey = `${options.canaryRunId}:pager-canary`;
  const pageRequest: ContinuousAssurancePageRequest = {
    dedupeKey: pagerKey,
    cycleId: options.canaryRunId,
    reason: 'bounded production provider canary',
    nowMs: options.nowMs,
    onCallRoute: options.onCallRoute,
    escalationTarget: options.escalationTarget,
  };
  const firstPage = await callPager(options.bindings.pager, pageRequest);
  if (firstPage.status !== 'accepted' || !firstPage.deliveryId) {
    throw new Error('production-provider-canary-pager-first-delivery-invalid');
  }
  receipts.push({
    action: 'pager-canary',
    idempotencyKey: pagerKey,
    operationId: firstPage.deliveryId,
    pagerDeliveryId: firstPage.deliveryId,
    observedAtMs: ++observedAtMs,
    status: 'success',
  });

  const duplicatePage = await callPager(options.bindings.pager, pageRequest);
  if (duplicatePage.status !== 'deduplicated') {
    throw new Error('production-provider-canary-pager-duplicate-not-suppressed');
  }
  receipts.push({
    action: 'pager-canary',
    idempotencyKey: pagerKey,
    operationId: firstPage.deliveryId,
    pagerDeliveryId: firstPage.deliveryId,
    observedAtMs: ++observedAtMs,
    status: 'deduplicated',
  });

  return {
    canaryRunId: options.canaryRunId,
    startedAtMs: options.nowMs,
    completedAtMs: observedAtMs,
    receipts,
  };
}

function preflight(options: ProductionProviderCanaryExecutionOptions): void {
  const auth = options.authorization;
  if (!options.canaryRunId || !Number.isFinite(options.nowMs) ||
    options.nowMs < auth.startsAtMs || options.nowMs > auth.expiresAtMs) {
    throw new Error('production-provider-canary-authorization-not-active');
  }
  const allowed = new Set(auth.allowedActions);
  if (allowed.size !== REQUIRED_ACTIONS.length || REQUIRED_ACTIONS.some((action) => !allowed.has(action))) {
    throw new Error('production-provider-canary-action-allowlist-invalid');
  }
  if (new Set(auth.approvers.filter(Boolean)).size < 2) {
    throw new Error('production-provider-canary-two-person-approval-required');
  }
}

function providerReceipt(
  action: 'provider-health' | 'provider-audit',
  idempotencyKey: string,
  operationId: string,
  observedAtMs: number,
  auth: ProductionProviderCanaryAuthorization,
): ProductionProviderCanaryReceipt {
  return {
    action,
    idempotencyKey,
    operationId,
    observedAtMs,
    status: 'success',
    providerName: auth.providerName,
    accountId: auth.accountId,
  };
}

function retrievalReceipt(
  action: 'primary-archive-retrieval' | 'backup-archive-retrieval',
  idempotencyKey: string,
  value: SteadyStateArchiveRetrieval,
  observedAtMs: number,
  auth: ProductionProviderCanaryAuthorization,
): ProductionProviderCanaryReceipt {
  if (value.integrityStatus !== 'pass' || value.archiveId !== auth.archiveId ||
    value.observedContentDigest !== auth.archiveContentDigest) {
    throw new Error(`production-provider-canary-archive-integrity-mismatch:${action}`);
  }
  const expectedStorage = action === 'primary-archive-retrieval' ? auth.primaryStorageId : auth.backupStorageId;
  if (value.storageId !== expectedStorage) {
    throw new Error(`production-provider-canary-storage-identity-mismatch:${action}`);
  }
  return {
    action,
    idempotencyKey,
    operationId: value.retrievalOperationId,
    observedAtMs,
    status: 'success',
    providerName: auth.providerName,
    accountId: auth.accountId,
    storageId: value.storageId,
    archiveId: value.archiveId,
    observedContentDigest: value.observedContentDigest,
    integrityStatus: value.integrityStatus,
  };
}

function providerOperationId(
  value: ContinuousAssuranceHealthResult | ContinuousAssuranceProviderAuditResult,
  field: string,
  error: string,
): string {
  const candidate = (value as unknown as Record<string, unknown>)[field];
  if (typeof candidate !== 'string' || !candidate) throw new Error(error);
  return candidate;
}

async function callPager(
  binding: ContinuousAssuranceServiceBinding,
  body: ContinuousAssurancePageRequest,
): Promise<{ status: 'accepted' | 'deduplicated'; deliveryId?: string }> {
  const response = await binding.fetch(new Request('https://pager-adapter.internal/page', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unzen-idempotency-key': body.dedupeKey,
    },
    body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error(`production-provider-canary-pager-http-${response.status}`);
  const payload = await response.json() as { status?: unknown; deliveryId?: unknown };
  if (payload.status !== 'accepted' && payload.status !== 'deduplicated') {
    throw new Error('production-provider-canary-pager-response-invalid');
  }
  return {
    status: payload.status,
    ...(typeof payload.deliveryId === 'string' ? { deliveryId: payload.deliveryId } : {}),
  };
}

function rejectBinding(label: string): ContinuousAssuranceServiceBinding {
  return {
    async fetch() {
      throw new Error(`production-provider-canary-unexpected-${label}-binding-call`);
    },
  };
}
