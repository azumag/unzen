import { describe, expect, it } from 'vitest';
import { executeProductionProviderCanary } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary-controller.js';
import type { ProductionProviderCanaryAuthorization } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.js';

const NOW = Date.parse('2026-08-20T04:30:00.000Z');

function authorization(overrides: Partial<ProductionProviderCanaryAuthorization> = {}): ProductionProviderCanaryAuthorization {
  const roles = ['controller', 'runtime', 'engine', 'provider', 'evidence', 'pager', 'verifier'] as const;
  return {
    authorizationId: 'auth-149',
    changeTicketId: 'CHG-149',
    authorizedAtMs: NOW - 10_000,
    startsAtMs: NOW,
    expiresAtMs: NOW + 60_000,
    approvers: ['operator-a', 'operator-b'],
    providerName: 'provider-prod',
    accountId: 'acct-prod',
    primaryStorageId: 'storage-primary',
    backupStorageId: 'storage-backup',
    archiveId: 'archive-1',
    archiveContentDigest: 'c'.repeat(64),
    allowedActions: ['provider-health', 'provider-audit', 'primary-archive-retrieval', 'backup-archive-retrieval', 'pager-canary'],
    deploymentVersionIds: Object.fromEntries(roles.map((role) => [role, `version-${role}-12345678`])) as any,
    deploymentConfigFingerprints: Object.fromEntries(roles.map((role, i) => [role, String(i + 1).repeat(64).slice(0, 64)])) as any,
    ...overrides,
  };
}

function bindings(options: { badDigest?: boolean; pagerDedup?: boolean } = {}) {
  const providerPaths: string[] = [];
  let pagerCalls = 0;
  return {
    providerPaths,
    getPagerCalls: () => pagerCalls,
    value: {
      provider: {
        async fetch(request: Request) {
          const url = new URL(request.url);
          providerPaths.push(url.pathname);
          const body = await request.json() as any;
          const baseRetrieval = {
            archiveId: 'archive-1',
            requestedAtMs: NOW,
            completedAtMs: NOW + 1,
            observedContentDigest: options.badDigest ? 'd'.repeat(64) : 'c'.repeat(64),
            integrityCheckId: 'integrity-1',
            integrityStatus: 'pass',
          };
          if (url.pathname === '/provider/health') {
            return Response.json({ providerHealthOperationId: 'health-op-1' });
          }
          if (url.pathname === '/provider/audit') {
            return Response.json({ auditStreamId: 'audit-stream-1' });
          }
          if (url.pathname === '/provider/archive/retrieve') {
            return Response.json({
              ...baseRetrieval,
              retrievalOperationId: `retrieve-${body.role}`,
              storageId: body.storageId,
            });
          }
          throw new Error(`unexpected provider path: ${url.pathname}`);
        },
      },
      pager: {
        async fetch() {
          pagerCalls += 1;
          if (pagerCalls === 1) return Response.json({ status: 'accepted', deliveryId: 'delivery-1' });
          return Response.json(options.pagerDedup === false
            ? { status: 'accepted', deliveryId: 'delivery-2' }
            : { status: 'deduplicated' });
        },
      },
    },
  };
}

describe('production provider canary bounded executor', () => {
  it('executes only health/audit/primary/backup/pager and preserves pager idempotency', async () => {
    const mock = bindings();
    const result = await executeProductionProviderCanary({
      canaryRunId: 'provider-canary-1',
      authorization: authorization(),
      nowMs: NOW,
      bindings: mock.value,
      onCallRoute: 'canary-oncall',
      escalationTarget: 'canary-escalation',
    });
    expect(mock.providerPaths).toEqual([
      '/provider/health',
      '/provider/audit',
      '/provider/archive/retrieve',
      '/provider/archive/retrieve',
    ]);
    expect(mock.providerPaths).not.toContain('/provider/keys/rotate');
    expect(mock.providerPaths).not.toContain('/provider/dr/exercise');
    expect(mock.getPagerCalls()).toBe(2);
    expect(result.receipts).toHaveLength(6);
    const pager = result.receipts.filter((r) => r.action === 'pager-canary');
    expect(pager.map((r) => r.status)).toEqual(['success', 'deduplicated']);
    expect(new Set(pager.map((r) => r.idempotencyKey)).size).toBe(1);
  });

  it('fails before any provider call when authorization is expired', async () => {
    const mock = bindings();
    await expect(executeProductionProviderCanary({
      canaryRunId: 'provider-canary-expired',
      authorization: authorization({ expiresAtMs: NOW - 1 }),
      nowMs: NOW,
      bindings: mock.value,
      onCallRoute: 'route', escalationTarget: 'target',
    })).rejects.toThrow('production-provider-canary-authorization-not-active');
    expect(mock.providerPaths).toEqual([]);
    expect(mock.getPagerCalls()).toBe(0);
  });

  it('stops on archive digest mismatch before pager delivery', async () => {
    const mock = bindings({ badDigest: true });
    await expect(executeProductionProviderCanary({
      canaryRunId: 'provider-canary-digest',
      authorization: authorization(),
      nowMs: NOW,
      bindings: mock.value,
      onCallRoute: 'route', escalationTarget: 'target',
    })).rejects.toThrow('production-provider-canary-archive-integrity-mismatch:primary-archive-retrieval');
    expect(mock.getPagerCalls()).toBe(0);
  });

  it('fails closed when pager does not deduplicate the repeated canary delivery', async () => {
    const mock = bindings({ pagerDedup: false });
    await expect(executeProductionProviderCanary({
      canaryRunId: 'provider-canary-pager',
      authorization: authorization(),
      nowMs: NOW,
      bindings: mock.value,
      onCallRoute: 'route', escalationTarget: 'target',
    })).rejects.toThrow('production-provider-canary-pager-duplicate-not-suppressed');
    expect(mock.getPagerCalls()).toBe(2);
  });
});
