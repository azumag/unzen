/**
 * Inference backend abstraction (issue #94).
 *
 * The legacy architecture centers on `SegmentExecutor` / `SegmentConfig` /
 * checkpoint relay: every worker is a segmented WebGPU executor. A
 * full-model backend (browser-managed model download, document context,
 * user activation) is a fundamentally different resource with no layer
 * ranges, no VRAM shards, and no checkpoints of its own.
 *
 * NOTE: the browser-built-in full-model route was originally targeted at the
 * Chrome Prompt API (issues #92/#93/#95/#100). That route was abandoned after
 * real-browser probing showed the API is not exposed without special flags /
 * enterprise policy, which does not meet the product's no-configuration
 * requirement. The abstract kind remains for a future full-model backend;
 * the Chrome-specific implementation was removed.
 *
 * This module defines the backend contract that both kinds (and a future
 * server-fallback kind) implement:
 *
 *   - `WorkerCapability` - the versioned, runtime-validated description of
 *     what one backend instance can do. It is the ONLY input to candidate
 *     selection, so the Coordinator never switches on a backend-specific
 *     type (issue #94 deliverable 5).
 *   - `InferenceEvent` - the discriminated union of everything a backend can
 *     emit while executing one request: streaming tokens/output, completion,
 *     abort/cancellation, context usage, prepare state, and errors carrying
 *     the structured `ErrorCode` taxonomy from `errors.ts`.
 *   - `InferenceBackend` - the request + lifecycle contract. It deliberately
 *     does NOT expose segment/checkpoint APIs; a full-model backend registers
 *     without pretending to be a `SegmentExecutor` (acceptance criterion).
 *
 * Versioning (issue #94 deliverable 6): `INFERENCE_PROTOCOL_VERSION` governs
 * the backend conversation and `CAPABILITY_SCHEMA_VERSION` governs the
 * capability schema. `isSupportedProtocolVersion()` rejects conversations
 * over an unknown protocol; `validateWorkerCapability()` (in
 * `inference-capability.ts`) rejects unknown fields unless the caller
 * explicitly opts into ignoring them. Unknown versions/fields are never
 * trusted silently.
 *
 * Typed separation (issue #94 deliverable 7): nothing in this module
 * references `SegmentConfig` or `Checkpoint`. A full-model capability has no
 * segment geometry at the type level.
 */

import type { ErrorCode } from './errors.js';

/** Version of the backend conversation (`describe/prepare/execute/dispose`). */
export const INFERENCE_PROTOCOL_VERSION = '1.0.0' as const;

/** Version of the `WorkerCapability` schema. */
export const CAPABILITY_SCHEMA_VERSION = '1.0.0' as const;

/**
 * The three backend kinds. `segmented-webgpu` is the legacy 30B segmented
 * route; `browser-built-in-full-model` is the reserved kind for a
 * browser-managed full-model backend (no concrete implementation exists
 * after the Chrome Prompt API route was abandoned); and `server-fallback` is
 * the reserved kind for a coordinated server-side fallback that the
 * Coordinator can treat as another routable candidate.
 */
export const INFERENCE_BACKEND_KINDS = [
  'segmented-webgpu',
  'browser-built-in-full-model',
  'server-fallback',
] as const;

export type InferenceBackendKind = (typeof INFERENCE_BACKEND_KINDS)[number];

/** True when the value is one of the declared backend kinds. */
export function isInferenceBackendKind(value: unknown): value is InferenceBackendKind {
  return (
    typeof value === 'string' &&
    (INFERENCE_BACKEND_KINDS as readonly string[]).includes(value)
  );
}

/** True when `version` is the protocol this host speaks. */
export function isSupportedProtocolVersion(version: string): boolean {
  return version === INFERENCE_PROTOCOL_VERSION;
}

/** A backend executes one full model OR one segment at a time. */
export type ExecutionMode = 'segment' | 'full-model';

/** Input modalities the backend accepts (narrow to text today). */
export type InputModality = 'text' | 'image' | 'audio';

/** Output modalities the backend can produce. */
export type OutputModality = 'text' | 'token-stream' | 'image' | 'audio';

/**
 * Browser-managed model download state. The values mirror the browser
 * built-in AI availability surface so a browser-managed backend can map its
 * native states directly.
 */
export type ModelDownloadState = 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** Where the backend executes: document context or a dedicated Worker. */
export type ExecutionSurface = 'document' | 'worker';

/** Whether inference state stays in the browser or leaves the device. */
export type PrivacyBoundary = 'in-browser' | 'server';

/**
 * Network destinations the backend is allowed to contact. The unzen security
 * model forbids third-party destinations (PLAN.md 1.2); the capability lists
 * the destinations a backend may legitimately reach so the Coordinator can
 * compare candidates on their network footprint.
 */
export type NetworkDestination = 'coordinator' | 'cdn' | 'server' | 'none';

/**
 * Runtime health/quality snapshot used for candidate ranking. `lastErrorCode`
 * reuses the structured taxonomy so failure reasons stay machine-readable.
 */
export interface WorkerHealth {
  readonly recentFailureRate: number;
  readonly lastErrorCode?: ErrorCode;
}

/**
 * The versioned, runtime-validated description of one backend instance.
 * Candidate selection reads ONLY this object; it is the routing input for all
 * three backend kinds (issue #94 deliverable 5).
 */
export interface WorkerCapability {
  /** Capability schema version; validated at registration time. */
  readonly schemaVersion: string;
  readonly backend: InferenceBackendKind;
  /** Runtime implementation name, e.g. 'webllm' or a future browser AI name. */
  readonly runtimeName: string;
  readonly runtimeVersion: string;
  /** Full-model or segment execution (legacy WebGPU route). */
  readonly executionMode: ExecutionMode;
  readonly inputModalities: readonly InputModality[];
  readonly outputModalities: readonly OutputModality[];
  readonly supportedLanguages: readonly string[];
  readonly streaming: boolean;
  readonly contextWindowTokens: number;
  /** Current context usage, when the runtime can report it. */
  readonly currentContextUsageTokens?: number;
  /** Browser-managed model download state, when applicable. */
  readonly modelDownloadState?: ModelDownloadState;
  /** True when execution requires a prior user activation gesture. */
  readonly requiresUserActivation: boolean;
  readonly executionSurfaces: readonly ExecutionSurface[];
  readonly supportsCancellation: boolean;
  readonly maxConcurrency: number;
  readonly expectedLatencyMs: number;
  readonly health?: WorkerHealth;
  readonly privacyBoundary: PrivacyBoundary;
  readonly allowedNetworkDestinations: readonly NetworkDestination[];
}

// --- Prepare lifecycle -------------------------------------------------------

export interface PrepareOptions {
  readonly modelId?: string;
  readonly priority?: 'low' | 'normal' | 'high';
  readonly signal?: AbortSignal;
}

/** Outcome of a `prepare()` call. `state: 'available'` means ready to run. */
export interface PreparationResult {
  readonly state: ModelDownloadState;
  /** Download progress in [0,1] while `state === 'downloading'`. */
  readonly progress?: number;
  readonly detail?: string;
}

// --- Request + events --------------------------------------------------------

/**
 * One inference request under the backend contract. This is deliberately
 * distinct from the legacy `types.ts` `InferenceRequest` (which is segmented /
 * pipeline-shaped): the backend contract is capability-shaped and carries the
 * protocol version so unknown-version conversations are rejected up front.
 */
export interface InferenceRequest {
  readonly protocolVersion: string;
  readonly requestId: string;
  readonly modelId?: string;
  readonly input: string;
  readonly maxTokens?: number;
  readonly requiresStreaming?: boolean;
}

/**
 * Discriminated union of everything a backend emits while executing a request
 * (issue #94 deliverable 4). Overflow is surfaced as an `error` event with
 * `code: ErrorCode.ContextOverflow` so the structured taxonomy stays the
 * single source of truth for failures.
 */
export type InferenceEvent =
  | InferenceTokenEvent
  | InferenceStreamEvent
  | InferenceCompletionEvent
  | InferenceAbortEvent
  | InferenceContextUsageEvent
  | InferencePrepareEvent
  | InferenceErrorEvent;

/** A single streaming token (token-granular streaming). */
export interface InferenceTokenEvent {
  readonly type: 'token';
  readonly token: string;
  readonly index: number;
}

/** Incremental text output (chunk-granular streaming). */
export interface InferenceStreamEvent {
  readonly type: 'stream';
  readonly text: string;
  readonly done: boolean;
}

/** The request finished successfully. */
export interface InferenceCompletionEvent {
  readonly type: 'completion';
  readonly requestId: string;
  readonly output: { readonly tokens: readonly number[]; readonly text: string };
  readonly totalTimeMs: number;
}

/** The execution was aborted/cancelled (user cancellation or deadline). */
export interface InferenceAbortEvent {
  readonly type: 'abort';
  readonly requestId: string;
  readonly reason: string;
}

/** A context-window usage snapshot. */
export interface InferenceContextUsageEvent {
  readonly type: 'context';
  readonly usageTokens: number;
  readonly limitTokens: number;
}

/** A model preparation state change (download lifecycle, progress). */
export interface InferencePrepareEvent {
  readonly type: 'prepare';
  readonly state: ModelDownloadState;
  /** Download progress in [0,1] while `state === 'downloading'`. */
  readonly progress?: number;
}

/** A failure carrying the structured `ErrorCode` taxonomy. */
export interface InferenceErrorEvent {
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
}

// --- Backend contract ---------------------------------------------------------

/**
 * The contract a backend implements. It is limited to request + lifecycle:
 * describe, prepare, execute, dispose. `SegmentExecutor` remains an internal
 * implementation detail of the segmented backend; a full-model backend is
 * never forced to expose segment or checkpoint APIs (issue #94 deliverable 3).
 */
export interface InferenceBackend {
  describeCapabilities(): Promise<WorkerCapability>;
  prepare(options?: PrepareOptions): Promise<PreparationResult>;
  execute(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>;
  dispose(): Promise<void>;
}
