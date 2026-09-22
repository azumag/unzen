import { describe, expect, it } from 'vitest';
import { BackendRegistry, capabilityMatchesRequest } from '../src/backend-registry.js';
import {
  CAPABILITY_SCHEMA_VERSION,
  INFERENCE_PROTOCOL_VERSION,
  type InferenceRequest,
  type WorkerCapability,
} from '../src/inference-backend.js';
import { validateWorkerCapability } from '../src/inference-capability.js';

function capability(): WorkerCapability {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    backend: 'server-fallback',
    runtimeName: 'owned-validation-test',
    runtimeVersion: '1.0.0',
    executionMode: 'full-model',
    inputModalities: ['text'],
    outputModalities: ['text', 'token-stream'],
    supportedLanguages: ['en', 'ja'],
    streaming: true,
    contextWindowTokens: 4096,
    currentContextUsageTokens: 128,
    modelDownloadState: 'available',
    requiresUserActivation: false,
    executionSurfaces: ['worker'],
    supportsCancellation: true,
    maxConcurrency: 1,
    expectedLatencyMs: 10,
    health: { recentFailureRate: 0 },
    privacyBoundary: 'server',
    allowedNetworkDestinations: ['coordinator', 'server'],
  };
}

function request(): InferenceRequest {
  return {
    protocolVersion: INFERENCE_PROTOCOL_VERSION,
    requestId: 'owned-capability-request',
    input: 'hello',
    maxTokens: 32,
    requiresStreaming: true,
  };
}

describe('worker capability owned validation', () => {
  it('returns the same single-read root, array, and health state that passed validation', () => {
    const source = { ...capability() } as Record<string, unknown>;
    let streamingReads = 0;
    let modalitiesReads = 0;
    let failureRateReads = 0;

    Object.defineProperty(source, 'streaming', {
      enumerable: true,
      get: () => {
        streamingReads++;
        return streamingReads === 1 ? true : 'altered';
      },
    });
    Object.defineProperty(source, 'inputModalities', {
      enumerable: true,
      get: () => {
        modalitiesReads++;
        return modalitiesReads === 1 ? ['text'] : ['audio'];
      },
    });
    const health: Record<string, unknown> = {};
    Object.defineProperty(health, 'recentFailureRate', {
      enumerable: true,
      get: () => {
        failureRateReads++;
        return failureRateReads === 1 ? 0 : 1;
      },
    });
    source.health = health;

    const result = validateWorkerCapability(source);

    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
    expect(result.capability?.streaming).toBe(true);
    expect(result.capability?.inputModalities).toEqual(['text']);
    expect(result.capability?.health?.recentFailureRate).toBe(0);
    expect(streamingReads).toBe(1);
    expect(modalitiesReads).toBe(1);
    expect(failureRateReads).toBe(1);
    expect(Object.isFrozen(result.capability)).toBe(true);
    expect(Object.isFrozen(result.capability?.inputModalities)).toBe(true);
    expect(Object.isFrozen(result.capability?.health)).toBe(true);
  });

  it('reads routing array elements once before validating and accepting them', () => {
    const modalities: unknown[] = ['text'];
    let reads = 0;
    Object.defineProperty(modalities, 0, {
      enumerable: true,
      configurable: true,
      get: () => {
        reads++;
        return reads === 1 ? 'text' : 'audio';
      },
    });
    const source = {
      ...capability(),
      inputModalities: modalities,
    };

    const result = validateWorkerCapability(source);

    expect(result.status).toBe('valid');
    expect(result.capability?.inputModalities).toEqual(['text']);
    expect(reads).toBe(1);
  });

  it('stores the validated owned capability without re-reading worker-owned fields', () => {
    const registry = new BackendRegistry();
    const source = { ...capability() } as Record<string, unknown>;
    let streamingReads = 0;
    Object.defineProperty(source, 'streaming', {
      enumerable: true,
      get: () => {
        streamingReads++;
        return streamingReads === 1 ? true : false;
      },
    });

    registry.registerCapability('owned-snapshot', source as unknown as WorkerCapability);

    const [entry] = registry.describeAll();
    expect(entry.capability.streaming).toBe(true);
    expect(streamingReads).toBe(1);
  });

  it('routes against the validated owned capability instead of re-reading the caller object', () => {
    const source = { ...capability() } as Record<string, unknown>;
    let modalitiesReads = 0;
    Object.defineProperty(source, 'inputModalities', {
      enumerable: true,
      get: () => {
        modalitiesReads++;
        return modalitiesReads === 1 ? ['text'] : ['audio'];
      },
    });

    expect(
      capabilityMatchesRequest(source as unknown as WorkerCapability, request()),
    ).toBe(true);
    expect(modalitiesReads).toBe(1);
  });

  it('fails closed when the routing request container is a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable(request(), {});
    revoke();

    expect(
      capabilityMatchesRequest(capability(), proxy as unknown as InferenceRequest),
    ).toBe(false);
  });

  it('fails closed when a routing request field accessor throws', () => {
    const source = { ...request() } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(source, 'maxTokens', {
      enumerable: true,
      get: () => {
        reads++;
        throw new Error('untrusted accessor failure');
      },
    });

    expect(
      capabilityMatchesRequest(capability(), source as unknown as InferenceRequest),
    ).toBe(false);
    expect(reads).toBe(1);
  });

  it('captures supported schema policy array entries once', () => {
    const versions: unknown[] = [CAPABILITY_SCHEMA_VERSION];
    let reads = 0;
    Object.defineProperty(versions, 0, {
      enumerable: true,
      configurable: true,
      get: () => {
        reads++;
        return reads === 1 ? CAPABILITY_SCHEMA_VERSION : '9.9.9';
      },
    });

    const result = validateWorkerCapability(capability(), {
      supportedSchemaVersions: versions as string[],
    });

    expect(result.status).toBe('valid');
    expect(reads).toBe(1);
  });
});
