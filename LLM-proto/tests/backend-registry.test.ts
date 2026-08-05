import { describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_SCHEMA_VERSION,
  INFERENCE_PROTOCOL_VERSION,
  type InferenceBackend,
  type InferenceEvent,
  type InferenceRequest,
  type WorkerCapability,
} from '../src/inference-backend.js';
import {
  BackendRegistry,
  capabilityMatchesRequest,
} from '../src/backend-registry.js';

/** Build a capability for a given backend kind (valid, ready to execute). */
function capabilityFor(
  backend: WorkerCapability['backend'],
  overrides: Partial<WorkerCapability> = {},
): WorkerCapability {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    backend,
    runtimeName: 'mock-runtime',
    runtimeVersion: '1.0.0',
    executionMode: backend === 'segmented-webgpu' ? 'segment' : 'full-model',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedLanguages: ['en'],
    streaming: true,
    contextWindowTokens: 4096,
    requiresUserActivation: false,
    executionSurfaces: ['worker'],
    supportsCancellation: true,
    maxConcurrency: 1,
    expectedLatencyMs: 100,
    privacyBoundary: 'in-browser',
    allowedNetworkDestinations: ['coordinator', 'cdn'],
    modelDownloadState: 'available',
    ...overrides,
  };
}

/** A scriptable mock backend (issue #94 deliverable 8). */
class MockInferenceBackend implements InferenceBackend {
  readonly dispose = vi.fn(async () => {});
  readonly prepare = vi.fn(async () => ({ state: 'available' as const }));

  constructor(
    private readonly capability: WorkerCapability,
    private readonly events: readonly InferenceEvent[] = [],
  ) {}

  describeCapabilities(): Promise<WorkerCapability> {
    return Promise.resolve(this.capability);
  }

  async *execute(_request: InferenceRequest): AsyncIterable<InferenceEvent> {
    for (const event of this.events) yield event;
  }
}

function request(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    protocolVersion: INFERENCE_PROTOCOL_VERSION,
    requestId: 'req-1',
    input: 'ping',
    ...overrides,
  };
}

describe('BackendRegistry (capability-based candidate selection)', () => {
  it('registers a backend and exposes its validated capability', async () => {
    const registry = new BackendRegistry();
    const backend = new MockInferenceBackend(capabilityFor('browser-built-in-full-model'));

    await registry.register('builtin-1', backend);

    expect(registry.size).toBe(1);
    const entry = registry.describeAll()[0];
    expect(entry.backendId).toBe('builtin-1');
    expect(entry.capability.backend).toBe('browser-built-in-full-model');
    expect(entry.capability.executionMode).toBe('full-model');
  });

  it('rejects a backend whose capability fails runtime validation', async () => {
    const registry = new BackendRegistry();
    const invalid = capabilityFor('segmented-webgpu', { contextWindowTokens: -5 });

    await expect(registry.register('broken', new MockInferenceBackend(invalid))).rejects.toThrow(
      /capability/i,
    );
    expect(registry.size).toBe(0);
  });

  it('rejects duplicate backend ids instead of silently overwriting', async () => {
    const registry = new BackendRegistry();
    const first = new MockInferenceBackend(capabilityFor('server-fallback'));
    await registry.register('dup-1', first);

    await expect(
      registry.register('dup-1', new MockInferenceBackend(capabilityFor('segmented-webgpu'))),
    ).rejects.toThrow(/already registered/i);
    expect(registry.size).toBe(1);
    // The original entry is preserved; the failed re-registration never lands.
    expect(registry.get('dup-1')).toBe(first);

    expect(() =>
      registry.registerCapability('dup-1', capabilityFor('segmented-webgpu')),
    ).toThrow(/already registered/i);
    expect(registry.size).toBe(1);
  });

  it('selects candidates by capability predicate, not by backend-specific types', async () => {
    const registry = new BackendRegistry();
    await registry.register('seg-1', new MockInferenceBackend(capabilityFor('segmented-webgpu')));
    await registry.register(
      'builtin-1',
      new MockInferenceBackend(capabilityFor('browser-built-in-full-model')),
    );
    await registry.register('server-1', new MockInferenceBackend(capabilityFor('server-fallback')));

    // Segmented, built-in, and server backends are comparable as the same
    // routing input (issue #94 acceptance criterion).
    expect(registry.selectCandidates((c) => c.backend === 'segmented-webgpu')).toEqual(['seg-1']);
    expect(registry.selectCandidates((c) => c.backend === 'browser-built-in-full-model')).toEqual([
      'builtin-1',
    ]);
    expect(registry.selectCandidates((c) => c.backend === 'server-fallback')).toEqual(['server-1']);
    expect(registry.selectCandidates((c) => c.executionMode === 'full-model')).toEqual([
      'builtin-1',
      'server-1',
    ]);
    expect(registry.selectCandidates((c) => c.streaming)).toEqual(['seg-1', 'builtin-1', 'server-1']);
  });

  it('routes a request to candidates whose capability satisfies the request', async () => {
    const registry = new BackendRegistry();
    await registry.register(
      'builtin-1',
      new MockInferenceBackend(capabilityFor('browser-built-in-full-model')),
    );
    // This backend cannot satisfy any text request (no text input modality).
    await registry.register(
      'audio-1',
      new MockInferenceBackend(
        capabilityFor('server-fallback', { inputModalities: ['audio'] }),
      ),
    );

    const candidates = registry.selectCandidates((c) =>
      capabilityMatchesRequest(c, request({ maxTokens: 1024 })),
    );
    expect(candidates).toEqual(['builtin-1']);
  });

  it('excludes a candidate whose context window cannot fit the requested tokens', async () => {
    const registry = new BackendRegistry();
    await registry.register(
      'small-1',
      new MockInferenceBackend(
        capabilityFor('server-fallback', { contextWindowTokens: 512 }),
      ),
    );
    await registry.register(
      'large-1',
      new MockInferenceBackend(
        capabilityFor('server-fallback', { contextWindowTokens: 8192 }),
      ),
    );

    const candidates = registry.selectCandidates((c) =>
      capabilityMatchesRequest(c, request({ maxTokens: 4096 })),
    );
    expect(candidates).toEqual(['large-1']);
  });

  it('excludes candidates that are not ready to execute (model preparation)', async () => {
    const registry = new BackendRegistry();
    await registry.register(
      'ready-1',
      new MockInferenceBackend(
        capabilityFor('browser-built-in-full-model', { modelDownloadState: 'available' }),
      ),
    );
    await registry.register(
      'downloading-1',
      new MockInferenceBackend(
        capabilityFor('browser-built-in-full-model', { modelDownloadState: 'downloading' }),
      ),
    );

    const candidates = registry.selectCandidates((c) =>
      capabilityMatchesRequest(c, request()),
    );
    expect(candidates).toEqual(['ready-1']);
  });

  it('excludes candidates spoken over an unsupported protocol version', async () => {
    const registry = new BackendRegistry();
    await registry.register(
      'v1-1',
      new MockInferenceBackend(capabilityFor('server-fallback')),
    );

    const candidates = registry.selectCandidates((c) =>
      capabilityMatchesRequest(c, request({ protocolVersion: '0.9.0' })),
    );
    expect(candidates).toEqual([]);
  });

  it('allows capability-only registration for legacy protocol adapters', async () => {
    const registry = new BackendRegistry();
    registry.registerCapability('legacy-1', capabilityFor('segmented-webgpu'));

    expect(registry.size).toBe(1);
    // Capability-only entries are routable...
    expect(registry.selectCandidates((c) => c.backend === 'segmented-webgpu')).toEqual(['legacy-1']);
    // ...but expose no executable InferenceBackend.
    expect(registry.get('legacy-1')).toBeUndefined();
  });

  it('disposes every registered backend', async () => {
    const registry = new BackendRegistry();
    const a = new MockInferenceBackend(capabilityFor('segmented-webgpu'));
    const b = new MockInferenceBackend(capabilityFor('server-fallback'));
    await registry.register('a', a);
    await registry.register('b', b);

    await registry.disposeAll();

    expect(a.dispose).toHaveBeenCalledOnce();
    expect(b.dispose).toHaveBeenCalledOnce();
  });

  it('executes a routed backend and collects its streamed events', async () => {
    const events: readonly InferenceEvent[] = [
      { type: 'token', token: 'hi', index: 0 },
      { type: 'token', token: ' there', index: 1 },
      { type: 'completion', requestId: 'req-1', output: { tokens: [5, 6], text: 'hi there' }, totalTimeMs: 2 },
    ];
    const registry = new BackendRegistry();
    const backend = new MockInferenceBackend(capabilityFor('server-fallback'), events);
    await registry.register('server-1', backend);

    const [backendId] = registry.selectCandidates((c) => c.backend === 'server-fallback');
    const resolved = registry.get(backendId);
    const collected: InferenceEvent[] = [];
    const signal = new AbortController().signal;
    for await (const event of resolved!.execute(request(), signal)) {
      collected.push(event);
    }
    expect(collected.map((event) => event.type)).toEqual(['token', 'token', 'completion']);
  });
});
