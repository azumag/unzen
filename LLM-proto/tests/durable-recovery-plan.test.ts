import { describe, expect, it } from 'vitest';
import { createCheckpointEnvelope } from '../src/checkpoint-envelope.js';
import { ErrorCode } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import {
  planDurableRequestRecovery,
  type DurableRecoverySnapshot,
} from '../src/durable-recovery-plan.js';
import type { Lease, RequestRecord } from '../src/durable-types.js';
import { workerId } from '../src/types.js';

const MANIFEST = 'manifest-recovery-test';
const NOW = 10_000;

function request(
  stage: RequestRecord['stage'],
  overrides: Partial<RequestRecord> = {},
): RequestRecord {
  return {
    requestId: generateRequestId(),
    prompt: 'recover me',
    stage,
    createdAt: 1_000,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: MANIFEST,
    retryCount: 0,
    ...overrides,
  };
}

function leaseFor(record: RequestRecord, overrides: Partial<Lease> = {}): Lease {
  return {
    requestId: record.requestId,
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('recovery-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: record.currentSegment,
    modelManifestDigest: MANIFEST,
    issuedAt: NOW - 100,
    expiresAt: NOW + 1_000,
    ...overrides,
  };
}

async function checkpointFor(record: RequestRecord, createdAt = NOW - 100) {
  return createCheckpointEnvelope({
    requestId: record.requestId,
    attemptId: generateAttemptId(),
    segmentIndex: record.currentSegment - 1,
    workerId: workerId('checkpoint-worker'),
    workerGeneration: generateWorkerGeneration(),
    modelManifestDigest: MANIFEST,
    formatVersion: 'float16',
    payload: new Uint8Array([1, 2, 3]),
    ttlMs: 1_000,
    createdAt,
  });
}

function plan(snapshot: DurableRecoverySnapshot) {
  return planDurableRequestRecovery(snapshot, {
    now: NOW,
    maxRetries: 2,
    manifestDigest: MANIFEST,
  });
}

describe('planDurableRequestRecovery', () => {
  it('does not restart a request that already reached a terminal stage', () => {
    const record = request('completed');
    expect(plan({ request: record, checkpoints: [] })).toEqual({
      kind: 'terminal',
      stage: 'completed',
    });
  });

  it('preserves the original absolute deadline instead of resetting timeout on restart', () => {
    const record = request('queued', { createdAt: 1_000, timeoutMs: 5_000 });
    expect(plan({ request: record, checkpoints: [] })).toMatchObject({
      kind: 'fail',
      code: ErrorCode.DeadlineExceeded,
    });
  });

  it('waits when leased/running work still has a valid owner lease', () => {
    const record = request('running');
    const activeLease = leaseFor(record);
    expect(plan({ request: record, activeLease, checkpoints: [] })).toMatchObject({
      kind: 'wait-active-owner',
      lease: activeLease,
    });
  });

  it('resumes running work only after an expired lease is explicitly identified for reclaim', () => {
    const record = request('running');
    const activeLease = leaseFor(record, { expiresAt: NOW });
    expect(plan({ request: record, activeLease, checkpoints: [] })).toMatchObject({
      kind: 'resume',
      fromStage: 'running',
      segmentIndex: 0,
      normalizeToQueued: true,
      reclaimLease: activeLease,
    });
  });

  it('resumes accepted/queued/retry-wait requests without resetting persisted retry budget', () => {
    const accepted = request('accepted');
    expect(plan({ request: accepted, checkpoints: [] })).toMatchObject({
      kind: 'resume',
      fromStage: 'accepted',
      normalizeToQueued: true,
    });

    const queued = request('queued');
    expect(plan({ request: queued, checkpoints: [] })).toMatchObject({
      kind: 'resume',
      fromStage: 'queued',
      normalizeToQueued: false,
    });

    const retryWait = request('retry-wait', { retryCount: 2 });
    expect(plan({ request: retryWait, checkpoints: [] })).toMatchObject({
      kind: 'resume',
      fromStage: 'retry-wait',
      normalizeToQueued: true,
    });
  });

  it('fails rather than inventing a fresh retry budget', () => {
    const record = request('retry-wait', { retryCount: 3 });
    expect(plan({ request: record, checkpoints: [] })).toMatchObject({
      kind: 'fail',
      code: ErrorCode.RuntimeTransient,
      message: expect.stringContaining('retry budget exceeded'),
    });
  });

  it('requires the committed predecessor checkpoint before continuation resumes', async () => {
    const record = request('queued', { currentSegment: 1 });
    expect(plan({ request: record, checkpoints: [] })).toMatchObject({
      kind: 'fail',
      code: ErrorCode.CheckpointIntegrityMismatch,
    });

    const checkpoint = await checkpointFor(record);
    expect(plan({ request: record, checkpoints: [checkpoint] })).toMatchObject({
      kind: 'resume',
      segmentIndex: 1,
      checkpoint,
    });
  });

  it('rejects expired or cross-manifest continuation checkpoints', async () => {
    const record = request('queued', { currentSegment: 1 });
    const expired = await checkpointFor(record, NOW - 1_000);
    expect(plan({ request: record, checkpoints: [expired] })).toMatchObject({
      kind: 'fail',
      code: ErrorCode.CheckpointIntegrityMismatch,
      message: expect.stringContaining('expired'),
    });

    const good = await checkpointFor(record);
    const wrongManifest = { ...good, modelManifestDigest: 'other-manifest' };
    expect(plan({ request: record, checkpoints: [wrongManifest] })).toMatchObject({
      kind: 'fail',
      code: ErrorCode.CheckpointIntegrityMismatch,
      message: expect.stringContaining('identity mismatch'),
    });
  });

  it('turns a durable cancellation marker into a terminalization command before resume', () => {
    const record = request('running');
    const activeLease = leaseFor(record);
    expect(plan({
      request: record,
      activeLease,
      checkpoints: [],
      cancellationPresent: true,
    })).toEqual({
      kind: 'cancel',
      reason: 'durable-cancellation',
      reclaimLease: activeLease,
    });
  });

  it('fails a mismatched active lease instead of treating it as recovery ownership', () => {
    const record = request('running');
    const activeLease = leaseFor(record, { segmentIndex: 1 });
    expect(plan({ request: record, activeLease, checkpoints: [] })).toMatchObject({
      kind: 'fail',
      code: ErrorCode.ResultIdentityMismatch,
      reclaimLease: activeLease,
    });
  });
});
