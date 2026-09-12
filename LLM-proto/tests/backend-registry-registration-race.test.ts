import { describe, expect, it } from 'vitest';
import { BackendRegistry } from '../src/backend-registry.js';
import {
  CAPABILITY_SCHEMA_VERSION,
  type InferenceBackend,
  type InferenceEvent,
  type InferenceRequest,
  type WorkerCapability,
} from '../src/inference-backend.js';

function capability(runtimeName = 'race-test'): WorkerCapability {
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class DeferredCapabilityBackend implements InferenceBackend {
  constructor(private readonly capabilityPromise: Promise<WorkerCapability>) {}

  describeCapabilities(): Promise<WorkerCapability> {
    return this.capabilityPromise;
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

describe('BackendRegistry registration atomicity', () => {
  it('reserves an id while async capability discovery is pending', async () => {
    const registry = new BackendRegistry();
    const pending = deferred<WorkerCapability>();
    const firstBackend = new DeferredCapabilityBackend(pending.promise);
    const firstRegistration = registry.register('shared-id', firstBackend);

    await expect(
      registry.register(
        'shared-id',
        new DeferredCapabilityBackend(Promise.resolve(capability('second'))),
      ),
    ).rejects.toThrow(/already registered/);
    expect(() => registry.registerCapability('shared-id', capability('legacy'))).toThrow(
      /already registered/,
    );
    expect(registry.size).toBe(0);

    pending.resolve(capability('first'));
    await firstRegistration;

    expect(registry.size).toBe(1);
    expect(registry.get('shared-id')).toBe(firstBackend);
    expect(registry.describeAll()[0].capability.runtimeName).toBe('first');
  });

  it('releases a reservation when capability discovery fails', async () => {
    const registry = new BackendRegistry();
    const pending = deferred<WorkerCapability>();
    const failedRegistration = registry.register(
      'retryable-id',
      new DeferredCapabilityBackend(pending.promise),
    );

    pending.reject(new Error('capability probe failed'));
    await expect(failedRegistration).rejects.toThrow(/capability probe failed/);

    registry.registerCapability('retryable-id', capability('retry-success'));
    expect(registry.size).toBe(1);
    expect(registry.describeAll()[0].capability.runtimeName).toBe('retry-success');
  });

  it('allows different backend ids to register concurrently', async () => {
    const registry = new BackendRegistry();
    const left = deferred<WorkerCapability>();
    const right = deferred<WorkerCapability>();
    const leftRegistration = registry.register(
      'left',
      new DeferredCapabilityBackend(left.promise),
    );
    const rightRegistration = registry.register(
      'right',
      new DeferredCapabilityBackend(right.promise),
    );

    left.resolve(capability('left-runtime'));
    right.resolve(capability('right-runtime'));
    await Promise.all([leftRegistration, rightRegistration]);

    expect(registry.size).toBe(2);
    expect(registry.selectCandidates(() => true).sort()).toEqual(['left', 'right']);
  });
});
