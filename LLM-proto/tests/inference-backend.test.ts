import { describe, expect, it } from 'vitest';
import type { Checkpoint, SegmentConfig } from '../src/types.js';
import {
  CAPABILITY_SCHEMA_VERSION,
  INFERENCE_BACKEND_KINDS,
  INFERENCE_PROTOCOL_VERSION,
  isSupportedProtocolVersion,
  type InferenceBackend,
  type InferenceEvent,
  type InferenceRequest,
  type WorkerCapability,
} from '../src/inference-backend.js';
import { ErrorCode } from '../src/errors.js';
import { validateWorkerCapability } from '../src/inference-capability.js';

/**
 * A structurally valid full-model capability used as the baseline fixture for
 * the type-level and validation contracts.
 */
function createFullModelCapability(overrides: Partial<WorkerCapability> = {}): WorkerCapability {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    backend: 'browser-built-in-full-model',
    runtimeName: 'browser-full-model',
    runtimeVersion: '1.0.0',
    executionMode: 'full-model',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedLanguages: ['ja', 'en'],
    streaming: true,
    contextWindowTokens: 4096,
    requiresUserActivation: true,
    executionSurfaces: ['document'],
    supportsCancellation: true,
    maxConcurrency: 1,
    expectedLatencyMs: 1000,
    privacyBoundary: 'in-browser',
    allowedNetworkDestinations: ['none'],
    ...overrides,
  };
}

describe('inference backend protocol versioning', () => {
  it('exports a protocol version and a capability schema version', () => {
    expect(typeof INFERENCE_PROTOCOL_VERSION).toBe('string');
    expect(typeof CAPABILITY_SCHEMA_VERSION).toBe('string');
    expect(INFERENCE_PROTOCOL_VERSION.length).toBeGreaterThan(0);
    expect(CAPABILITY_SCHEMA_VERSION.length).toBeGreaterThan(0);
  });

  it('accepts only the current protocol version', () => {
    expect(isSupportedProtocolVersion(INFERENCE_PROTOCOL_VERSION)).toBe(true);
    expect(isSupportedProtocolVersion('0.1.0')).toBe(false);
    expect(isSupportedProtocolVersion('')).toBe(false);
  });

  it('enumerates the three backend kinds', () => {
    expect(INFERENCE_BACKEND_KINDS).toEqual([
      'segmented-webgpu',
      'browser-built-in-full-model',
      'server-fallback',
    ]);
  });
});

describe('WorkerCapability runtime validation', () => {
  it('accepts a structurally valid full-model capability', () => {
    const result = validateWorkerCapability(createFullModelCapability());
    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
  });

  it('rejects an unsupported capability schema version', () => {
    const result = validateWorkerCapability(
      createFullModelCapability({ schemaVersion: '9.9.9' }),
    );
    expect(result.status).toBe('invalid');
    expect(result.issues.map((issue) => issue.code)).toContain('unsupported-schema-version');
  });

  it('rejects an unknown top-level field by default (never trusts silently)', () => {
    const result = validateWorkerCapability({
      ...createFullModelCapability(),
      inventedField: 'guess',
    });
    expect(result.status).toBe('invalid');
    expect(result.issues.map((issue) => issue.code)).toContain('unknown-field');
  });

  it('ignores an unknown top-level field when explicitly opted in', () => {
    const result = validateWorkerCapability(
      { ...createFullModelCapability(), inventedField: 'guess' },
      { unknownFieldPolicy: 'ignore' },
    );
    expect(result.status).toBe('valid');
  });

  it('rejects an unknown backend kind', () => {
    const result = validateWorkerCapability(
      createFullModelCapability({ backend: 'mystery-backend' as never }),
    );
    expect(result.status).toBe('invalid');
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-backend');
  });

  it('rejects a non-positive context window', () => {
    const result = validateWorkerCapability(createFullModelCapability({ contextWindowTokens: 0 }));
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-context-window');
  });

  it('rejects context usage above the context window', () => {
    const result = validateWorkerCapability(
      createFullModelCapability({ currentContextUsageTokens: 5000 }),
    );
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-context-window');
  });

  it('accepts context usage inside the context window', () => {
    const result = validateWorkerCapability(
      createFullModelCapability({ currentContextUsageTokens: 128 }),
    );
    expect(result.status).toBe('valid');
  });

  it('rejects an invalid browser-managed model download state', () => {
    const result = validateWorkerCapability(
      createFullModelCapability({ modelDownloadState: 'broken' as never }),
    );
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-download-state');
  });

  it('accepts the four model download states', () => {
    for (const state of ['unavailable', 'downloadable', 'downloading', 'available'] as const) {
      const result = validateWorkerCapability(
        createFullModelCapability({ modelDownloadState: state }),
      );
      expect(result.status).toBe('valid');
    }
  });

  it('rejects a health failure rate outside [0,1]', () => {
    const result = validateWorkerCapability(
      createFullModelCapability({ health: { recentFailureRate: 1.5 } }),
    );
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-health');
  });

  it('rejects an unknown structured error code in the health record', () => {
    const result = validateWorkerCapability(
      createFullModelCapability({
        health: { recentFailureRate: 0.1, lastErrorCode: 'not-a-code' as never },
      }),
    );
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-health');
  });

  it('rejects an unknown privacy boundary', () => {
    const result = validateWorkerCapability(
      createFullModelCapability({ privacyBoundary: 'shared' as never }),
    );
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-privacy-boundary');
  });
});

describe('InferenceEvent discriminated union', () => {
  it('expresses streaming tokens, completion, context usage, prepare state, and errors', () => {
    const token: InferenceEvent = { type: 'token', token: 'hello', index: 0 };
    const completion: InferenceEvent = {
      type: 'completion',
      requestId: 'req-1',
      output: { tokens: [1, 2], text: 'hello world' },
      totalTimeMs: 42,
    };
    const context: InferenceEvent = { type: 'context', usageTokens: 10, limitTokens: 4096 };
    const prepare: InferenceEvent = { type: 'prepare', state: 'downloading', progress: 0.5 };
    const abort: InferenceEvent = { type: 'abort', requestId: 'req-1', reason: 'user cancel' };
    const error: InferenceEvent = {
      type: 'error',
      code: ErrorCode.ContextOverflow,
      message: 'context window exceeded',
    };

    expect(token).toMatchObject({ type: 'token' });
    expect(completion).toMatchObject({ type: 'completion' });
    expect(context).toMatchObject({ type: 'context' });
    expect(prepare).toMatchObject({ type: 'prepare' });
    expect(abort).toMatchObject({ type: 'abort' });
    expect(error).toMatchObject({ type: 'error', code: ErrorCode.ContextOverflow });
  });
});

describe('type-level separation (issue #94 deliverable 7)', () => {
  function consumeSegment(_segment: SegmentConfig): void {
    void _segment;
  }

  function consumeCheckpoint(_checkpoint: Checkpoint): void {
    void _checkpoint;
  }

  it('keeps SegmentConfig and Checkpoint out of the backend capability contract', () => {
    const capability: WorkerCapability = createFullModelCapability();
    // @ts-expect-error issue #94: a capability is NOT a SegmentConfig (no layer
    // range / VRAM shard / weight hash at the type level).
    consumeSegment(capability);
    // @ts-expect-error issue #94: a capability is NOT a Checkpoint.
    consumeCheckpoint(capability);
  });
});

describe('InferenceBackend contract', () => {
  it('is satisfiable by a backend whose execute() yields events', async () => {
    const events: InferenceEvent[] = [
      { type: 'token', token: 'ok', index: 0 },
      {
        type: 'completion',
        requestId: 'req-1',
        output: { tokens: [7], text: 'ok' },
        totalTimeMs: 1,
      },
    ];
    const request: InferenceRequest = {
      protocolVersion: INFERENCE_PROTOCOL_VERSION,
      requestId: 'req-1',
      input: 'ping',
    };
    const backend: InferenceBackend = {
      describeCapabilities: async () => createFullModelCapability(),
      prepare: async () => ({ state: 'available' }),
      execute: async function* () {
        for (const event of events) yield event;
      },
      dispose: async () => {},
    };

    const collected: InferenceEvent[] = [];
    const signal = new AbortController().signal;
    for await (const event of backend.execute(request, signal)) {
      collected.push(event);
    }
    expect(collected.map((event) => event.type)).toEqual(['token', 'completion']);
  });
});
