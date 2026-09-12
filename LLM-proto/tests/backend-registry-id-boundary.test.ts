import { describe, expect, it } from 'vitest';
import { BackendRegistry } from '../src/backend-registry.js';
import {
  CAPABILITY_SCHEMA_VERSION,
  type InferenceBackend,
  type InferenceEvent,
  type InferenceRequest,
  type WorkerCapability,
} from '../src/inference-backend.js';

function capability(runtimeName = 'id-boundary'): WorkerCapability {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    backend: 'server-fallback',
    runtimeName,
    runtimeVersion: '1.0.0',
    executionMode: 'full-model',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedLanguages: ['en'],
    streaming: true,
    contextWindowTokens: 4096,
    modelDownloadState: 'available',
    requiresUserActivation: false,
    executionSurfaces: ['worker'],
    supportsCancellation: true,
    maxConcurrency: 1,
    expectedLatencyMs: 1,
    privacyBoundary: 'server',
    allowedNetworkDestinations: ['coordinator'],
  };
}

class StaticBackend implements InferenceBackend {
  constructor(private readonly capabilityValue = capability()) {}

  describeCapabilities(): Promise<WorkerCapability> {
    return Promise.resolve(this.capabilityValue);
  }

  prepare(): Promise<{ readonly state: 'available' }> {
    return Promise.resolve({ state: 'available' });
  }

  async *execute(
    _request: InferenceRequest,
    _signal: AbortSignal,
  ): AsyncIterable<InferenceEvent> {
    return;
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe('BackendRegistry backend id boundary', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '  \t\n'],
    ['non-string', 123 as unknown as string],
  ])('rejects %s ids before async registration state is reserved', async (_label, backendId) => {
    const registry = new BackendRegistry();

    await expect(registry.register(backendId, new StaticBackend())).rejects.toThrow(
      /backendId must be a non-empty string/,
    );
    expect(registry.size).toBe(0);

    await registry.register('valid-after-rejection', new StaticBackend());
    expect(registry.size).toBe(1);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['non-string', {} as unknown as string],
  ])('rejects %s ids before capability-only registration mutates state', (_label, backendId) => {
    const registry = new BackendRegistry();

    expect(() => registry.registerCapability(backendId, capability())).toThrow(
      /backendId must be a non-empty string/,
    );
    expect(registry.size).toBe(0);
  });

  it('preserves padded non-empty ids as exact distinct identities', () => {
    const registry = new BackendRegistry();

    registry.registerCapability(' backend-a ', capability('padded'));
    registry.registerCapability('backend-a', capability('trimmed'));

    expect(registry.size).toBe(2);
    expect(registry.describeAll().map((entry) => entry.backendId)).toEqual([
      ' backend-a ',
      'backend-a',
    ]);
  });
});
