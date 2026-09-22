/**
 * Backend registry: capability-based candidate selection (issue #94
 * deliverable 5).
 *
 * The Coordinator selects candidates by CAPABILITY, never by a
 * backend-specific type. All three kinds (segmented-webgpu,
 * browser-built-in-full-model, server-fallback) are registered here and
 * compared through the same `WorkerCapability` routing input.
 *
 * Two registration paths exist:
 *
 *   - `register()` - for backends implementing the `InferenceBackend`
 *     contract. The capability is runtime-validated before it enters the
 *     routing table.
 *   - `registerCapability()` - for capability-only entries, e.g. legacy
 *     workers adapted from the old Worker registration protocol
 *     (`legacy-worker-adapter.ts`). These are routable but expose no
 *     executable backend.
 */
import type { InferenceBackend, InferenceRequest, WorkerCapability } from './inference-backend.js';
import { isSupportedProtocolVersion } from './inference-backend.js';
import { assertValidWorkerCapability, validateWorkerCapability } from './inference-capability.js';

/** A single routable entry: the capability (and optional backend). */
export interface CapabilityEntry {
  readonly backendId: string;
  readonly capability: WorkerCapability;
  readonly backend?: InferenceBackend;
}

type RoutingRequestEnvelope = Pick<
  InferenceRequest,
  'protocolVersion' | 'maxTokens' | 'requiresStreaming'
>;

/** Classify the caller-owned request container without leaking revoked-Proxy failures. */
function isRoutingRequestObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * Capture each caller-owned routing field once, then validate and route only
 * from that owned state. Accessor/Proxy-backed requests therefore cannot pass
 * validation with one value and influence routing with a later re-read.
 */
function validatedRoutingRequestEnvelope(value: unknown): RoutingRequestEnvelope | undefined {
  if (!isRoutingRequestObject(value)) return undefined;

  let protocolVersion: unknown;
  let maxTokens: unknown;
  let requiresStreaming: unknown;
  try {
    protocolVersion = value.protocolVersion;
    maxTokens = value.maxTokens;
    requiresStreaming = value.requiresStreaming;
  } catch {
    return undefined;
  }

  if (
    typeof protocolVersion !== 'string' ||
    !isSupportedProtocolVersion(protocolVersion)
  ) {
    return undefined;
  }
  if (
    maxTokens !== undefined &&
    (
      typeof maxTokens !== 'number' ||
      !Number.isSafeInteger(maxTokens) ||
      maxTokens < 0
    )
  ) {
    return undefined;
  }
  if (
    requiresStreaming !== undefined &&
    typeof requiresStreaming !== 'boolean'
  ) {
    return undefined;
  }

  return Object.freeze({
    protocolVersion,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(requiresStreaming !== undefined ? { requiresStreaming } : {}),
  });
}

function validatedRoutingCapability(value: unknown): WorkerCapability | undefined {
  const validation = validateWorkerCapability(value);
  return validation.status === 'valid' ? validation.capability : undefined;
}

/**
 * True when a capability can satisfy a request. Used as the routing predicate
 * so every candidate kind is compared through the same capability input.
 * Malformed capability/request envelopes and unsupported protocol versions
 * match nothing (never trusted silently).
 */
export function capabilityMatchesRequest(
  capability: WorkerCapability,
  request: InferenceRequest,
): boolean {
  const validatedRequest = validatedRoutingRequestEnvelope(request);
  if (validatedRequest === undefined) return false;
  const validatedCapability = validatedRoutingCapability(capability);
  if (validatedCapability === undefined) return false;
  if (!validatedCapability.inputModalities.includes('text')) return false;
  if (
    validatedRequest.requiresStreaming === true &&
    validatedCapability.streaming === false
  ) {
    return false;
  }
  if (
    validatedRequest.maxTokens !== undefined &&
    validatedCapability.contextWindowTokens < validatedRequest.maxTokens
  ) {
    return false;
  }
  // A backend that has not finished model preparation is not ready to execute.
  if (
    validatedCapability.modelDownloadState !== undefined &&
    validatedCapability.modelDownloadState !== 'available'
  ) {
    return false;
  }
  return true;
}

export class BackendRegistry {
  private readonly entries = new Map<string, CapabilityEntry>();
  /**
   * Async registration crosses an await boundary while capabilities are read
   * from the backend. Reserve ids during that window so another register path
   * cannot pass the duplicate check and silently overwrite the eventual entry.
   */
  private readonly pendingBackendIds = new Set<string>();

  /** Number of routable entries. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Register a backend implementing the `InferenceBackend` contract. The
   * capability is runtime-validated; an invalid capability rejects the whole
   * registration so the routing table never contains an untrusted entry.
   * The validator returns the owned/frozen capability that crossed the trust
   * boundary, so registration never re-reads backend-owned routing facts.
   */
  async register(backendId: string, backend: InferenceBackend): Promise<void> {
    this.assertBackendIdAvailable(backendId);
    this.pendingBackendIds.add(backendId);
    try {
      const capability = await backend.describeCapabilities();
      const snapshot = assertValidWorkerCapability(capability);
      this.entries.set(
        backendId,
        Object.freeze({ backendId, capability: snapshot, backend }),
      );
    } finally {
      // Failure must not poison this id permanently. Successful registration is
      // protected by `entries`; failed registration becomes retryable.
      this.pendingBackendIds.delete(backendId);
    }
  }

  /**
   * Register a capability without an executable backend. Used by the legacy
   * protocol adapter: the worker is routable (visible to candidate selection)
   * but is still driven through the old `SegmentExecutor` path.
   */
  registerCapability(backendId: string, capability: WorkerCapability): void {
    this.assertBackendIdAvailable(backendId);
    const snapshot = assertValidWorkerCapability(capability);
    this.entries.set(
      backendId,
      Object.freeze({ backendId, capability: snapshot }),
    );
  }

  /** Remove a backend. Returns true when it existed. */
  unregister(backendId: string): boolean {
    return this.entries.delete(backendId);
  }

  /** All routable entries, keyed by backend id. */
  describeAll(): readonly CapabilityEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Select candidate backend ids whose capability satisfies the predicate.
   * The predicate is the only routing interface; candidates of every kind are
   * comparable through their capability alone.
   */
  selectCandidates(
    predicate: (capability: WorkerCapability) => boolean,
  ): readonly string[] {
    const matches: string[] = [];
    for (const [backendId, entry] of this.entries) {
      if (predicate(entry.capability)) matches.push(backendId);
    }
    return matches;
  }

  /** The executable backend for a full backend registration, if any. */
  get(backendId: string): InferenceBackend | undefined {
    return this.entries.get(backendId)?.backend;
  }

  /** Dispose every registered backend (idempotent across clears). */
  async disposeAll(): Promise<void> {
    const backends = [...this.entries.values()].map((entry) => entry.backend);
    this.entries.clear();
    await Promise.all(
      backends
        .filter((backend): backend is InferenceBackend => backend !== undefined)
        .map((backend) => backend.dispose()),
    );
  }

  private assertBackendIdAvailable(backendId: unknown): asserts backendId is string {
    if (typeof backendId !== 'string' || backendId.trim().length === 0) {
      throw new Error('backendId must be a non-empty string');
    }
    if (this.entries.has(backendId) || this.pendingBackendIds.has(backendId)) {
      throw new Error(`backend already registered: ${backendId}`);
    }
  }
}
