import type {
  SegmentFailedMessage,
  SegmentResultMessage,
  WorkerHeartbeatMessage,
  WorkerMessage,
  WorkerRegisterMessage,
} from './protocol.js';
import {
  inferenceRequestId,
  workerId,
  WorkerTier,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePayload(value: unknown, type: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${type} payload must be a non-null, non-array object`);
  }
  return value;
}

function requireWorkerId(value: unknown, field = 'workerId') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return workerId(value);
}

function requireRequestId(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('requestId must be a non-empty string');
  }
  return inferenceRequestId(value);
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function requireNonNegativeFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number`);
  }
  return value;
}

function snapshotRegistration(payloadValue: unknown): WorkerRegisterMessage {
  const payload = requirePayload(payloadValue, 'worker:register');
  const capturedWorkerId = payload.workerId;
  const capturedTier = payload.tier;
  const capturedVramMB = payload.vramMB;

  const stableWorkerId = requireWorkerId(capturedWorkerId);
  if (
    capturedTier !== WorkerTier.TIER_1 &&
    capturedTier !== WorkerTier.TIER_2 &&
    capturedTier !== WorkerTier.TIER_3
  ) {
    throw new TypeError('worker:register tier must be 1, 2, or 3');
  }
  if (
    typeof capturedVramMB !== 'number' ||
    !Number.isFinite(capturedVramMB) ||
    capturedVramMB <= 0
  ) {
    throw new TypeError('worker:register vramMB must be a positive finite number');
  }

  return Object.freeze({
    type: 'worker:register',
    payload: Object.freeze({
      workerId: stableWorkerId,
      tier: capturedTier,
      vramMB: capturedVramMB,
    }),
  });
}

function snapshotHeartbeat(payloadValue: unknown): WorkerHeartbeatMessage {
  const payload = requirePayload(payloadValue, 'worker:heartbeat');
  const capturedWorkerId = payload.workerId;
  const capturedTimestamp = payload.timestamp;

  return Object.freeze({
    type: 'worker:heartbeat',
    payload: Object.freeze({
      workerId: requireWorkerId(capturedWorkerId),
      timestamp: requireNonNegativeFiniteNumber(
        capturedTimestamp,
        'worker:heartbeat timestamp',
      ),
    }),
  });
}

function snapshotSegmentResult(payloadValue: unknown): SegmentResultMessage {
  const payload = requirePayload(payloadValue, 'segment:result');
  const capturedRequestId = payload.requestId;
  const capturedSegmentIndex = payload.segmentIndex;
  const capturedWorkerId = payload.workerId;
  const capturedCheckpoint = payload.checkpoint;
  const capturedOutput = payload.output;
  const capturedProcessingTimeMs = payload.processingTimeMs;

  if (capturedCheckpoint !== undefined && !isRecord(capturedCheckpoint)) {
    throw new TypeError('segment:result checkpoint must be an object when present');
  }
  if (capturedOutput !== undefined && !isRecord(capturedOutput)) {
    throw new TypeError('segment:result output must be an object when present');
  }

  return Object.freeze({
    type: 'segment:result',
    payload: Object.freeze({
      requestId: requireRequestId(capturedRequestId),
      segmentIndex: requireNonNegativeSafeInteger(capturedSegmentIndex, 'segmentIndex'),
      workerId: requireWorkerId(capturedWorkerId),
      checkpoint: capturedCheckpoint as SegmentResultMessage['payload']['checkpoint'],
      output: capturedOutput as SegmentResultMessage['payload']['output'],
      processingTimeMs: requireNonNegativeFiniteNumber(
        capturedProcessingTimeMs,
        'processingTimeMs',
      ),
    }),
  });
}

function snapshotSegmentFailure(payloadValue: unknown): SegmentFailedMessage {
  const payload = requirePayload(payloadValue, 'segment:failed');
  const capturedRequestId = payload.requestId;
  const capturedSegmentIndex = payload.segmentIndex;
  const capturedWorkerId = payload.workerId;
  const capturedReason = payload.reason;

  if (typeof capturedReason !== 'string') {
    throw new TypeError('segment:failed reason must be a string');
  }

  return Object.freeze({
    type: 'segment:failed',
    payload: Object.freeze({
      requestId: requireRequestId(capturedRequestId),
      segmentIndex: requireNonNegativeSafeInteger(capturedSegmentIndex, 'segmentIndex'),
      workerId: requireWorkerId(capturedWorkerId),
      reason: capturedReason,
    }),
  });
}

/**
 * Convert one transport-facing worker message into one validated owned envelope.
 *
 * The discriminator, payload reference, and every declared field of the chosen
 * variant are read exactly once. Unknown properties are never enumerated. This
 * prevents accessor/Proxy inputs from changing identity or routing data between
 * validation and dispatch.
 */
export function snapshotWorkerMessage(message: unknown): WorkerMessage {
  if (!isRecord(message)) {
    throw new TypeError('worker message must be a non-null, non-array object');
  }

  const type = message.type;
  switch (type) {
    case 'worker:register': {
      const payload = message.payload;
      return snapshotRegistration(payload);
    }
    case 'worker:heartbeat': {
      const payload = message.payload;
      return snapshotHeartbeat(payload);
    }
    case 'segment:result': {
      const payload = message.payload;
      return snapshotSegmentResult(payload);
    }
    case 'segment:failed': {
      const payload = message.payload;
      return snapshotSegmentFailure(payload);
    }
    default:
      throw new TypeError(`unsupported worker message type: ${String(type)}`);
  }
}
