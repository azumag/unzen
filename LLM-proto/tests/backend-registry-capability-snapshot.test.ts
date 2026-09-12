import { describe, expect, it } from 'vitest';
import { BackendRegistry } from '../src/backend-registry.js';
import {
  CAPABILITY_SCHEMA_VERSION,
  type InferenceBackend,
  type InferenceEvent,
  type InferenceRequest,
  type WorkerCapability,
} from '../src/inference-backend.js';

function capability(): WorkerCapability {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    backend: 'server-fallback',
    runtimeName: 'snapshot-test',
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

class MutableCapabilityBackend implements InferenceBackend {
  constructor(readonly source: WorkerCapability) {}

  describeCapabilities(): Promise<WorkerCapability> {
    return Promise.resolve(this.source);
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

function mutateSource(source: WorkerCapability): void {
  const mutable = source as unknown as {
    streaming: boolean;
    inputModalities: string[];
    outputModalities: string[];
    supportedLanguages: string[];
    executionSurfaces: string[];
    allowedNetworkDestinations: string[];
    health: { recentFailureRate: number };
  };
  mutable.streaming = false;
  mutable.inputModalities[0] = 'audio';
  mutable.outputModalities[0] = 'audio';
  mutable.supportedLanguages[0] = 'xx';
  mutable.executionSurfaces[0] = 'document';
  mutable.allowedNetworkDestinations[0] = 'none';
  mutable.health.recentFailureRate = 1;
}

function expectSnapshotIsStable(registry: BackendRegistry, source: WorkerCapability): void {
  const [entry] = registry.describeAll();
  expect(entry.capability).not.toBe(source);
  expect(entry.capability.inputModalities).not.toBe(source.inputModalities);
  expect(entry.capability.outputModalities).not.toBe(source.outputModalities);
  expect(entry.capability.supportedLanguages).not.toBe(source.supportedLanguages);
  expect(entry.capability.executionSurfaces).not.toBe(source.executionSurfaces);
  expect(entry.capability.allowedNetworkDestinations).not.toBe(source.allowedNetworkDestinations);
  expect(entry.capability.health).not.toBe(source.health);

  expect(entry.capability.streaming).toBe(true);
  expect(entry.capability.inputModalities).toEqual(['text']);
  expect(entry.capability.outputModalities).toEqual(['text', 'token-stream']);
  expect(entry.capability.supportedLanguages).toEqual(['en', 'ja']);
  expect(entry.capability.executionSurfaces).toEqual(['worker']);
  expect(entry.capability.allowedNetworkDestinations).toEqual(['coordinator', 'server']);
  expect(entry.capability.health?.recentFailureRate).toBe(0);

  expect(Object.isFrozen(entry)).toBe(true);
  expect(Object.isFrozen(entry.capability)).toBe(true);
  expect(Object.isFrozen(entry.capability.inputModalities)).toBe(true);
  expect(Object.isFrozen(entry.capability.outputModalities)).toBe(true);
  expect(Object.isFrozen(entry.capability.supportedLanguages)).toBe(true);
  expect(Object.isFrozen(entry.capability.executionSurfaces)).toBe(true);
  expect(Object.isFrozen(entry.capability.allowedNetworkDestinations)).toBe(true);
  expect(Object.isFrozen(entry.capability.health)).toBe(true);

  expect(
    registry.selectCandidates(
      (candidate) =>
        candidate.streaming &&
        candidate.inputModalities.includes('text') &&
        candidate.health?.recentFailureRate === 0,
    ),
  ).toEqual([entry.backendId]);
}

describe('BackendRegistry capability snapshots', () => {
  it('isolates capability-only registrations from later caller mutation', () => {
    const registry = new BackendRegistry();
    const source = capability();

    registry.registerCapability('legacy-snapshot', source);
    mutateSource(source);

    expectSnapshotIsStable(registry, source);
  });

  it('isolates backend registrations from later backend-owned mutation', async () => {
    const registry = new BackendRegistry();
    const source = capability();
    const backend = new MutableCapabilityBackend(source);

    await registry.register('backend-snapshot', backend);
    mutateSource(source);

    expectSnapshotIsStable(registry, source);
    expect(registry.get('backend-snapshot')).toBe(backend);
  });
});
