/**
 * Chrome Built-in AI full-model backend descriptor (issue #92, #94).
 *
 * The Chrome backend runs one full model inside the document's Prompt API
 * session. It has NO segment geometry, NO artifact hashes, and NO VRAM
 * partitioning: every segmented-model field is absent by construction, and the
 * validator rejects any descriptor that fabricates them.
 *
 * Since issue #94 the descriptor carries a real, typed `WorkerCapability`
 * instead of the old `capabilities: readonly string[]` bag of string tags.
 * The capability is runtime-validated (`validateWorkerCapability`) at
 * validation time, so the full-model capability can never smuggle in segment
 * geometry through the typed field either.
 */

import {
  CAPABILITY_SCHEMA_VERSION,
  type WorkerCapability,
} from './inference-backend.js';
import { validateWorkerCapability } from './inference-capability.js';

export const BROWSER_BUILT_IN_MODEL_SCHEMA_VERSION = '1.0.0' as const;

export interface BrowserBuiltInModelDescriptor {
  readonly schemaVersion: string;
  readonly backend: 'browser-built-in-full-model';
  readonly provider: 'chrome';
  readonly api: 'prompt-api';
  readonly runtimeVersion: string;
  /** Typed, runtime-validated capability of the Chrome full-model backend. */
  readonly capability: WorkerCapability;
}

export interface BrowserBuiltInModelValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface BrowserBuiltInModelValidationResult {
  readonly status: 'valid' | 'invalid';
  readonly issues: readonly BrowserBuiltInModelValidationIssue[];
}

/** Segment-only fields that a full-model backend must never declare. */
const FORBIDDEN_SEGMENT_GEOMETRY_FIELDS = [
  'segments',
  'totalLayers',
  'modelWeightHash',
  'estimatedVramMB',
  'manifestDigest',
  'source',
] as const;

/**
 * Default Chrome full-model capability.
 *
 * `contextWindowTokens` (4096) and `expectedLatencyMs` are EXAMPLE placeholders
 * pending the real-browser measurement tracked by issue #93; they are not
 * measured facts. Overrides let the caller supply measured values once the
 * harness evidence exists.
 */
export function buildChromePromptApiCapability(
  runtimeVersion: string,
  overrides: Partial<WorkerCapability> = {},
): WorkerCapability {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    backend: 'browser-built-in-full-model',
    runtimeName: 'chrome-prompt-api',
    runtimeVersion,
    executionMode: 'full-model',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedLanguages: ['ja', 'en'],
    streaming: true,
    // EXAMPLE placeholder pending real-browser measurement (#93).
    contextWindowTokens: 4096,
    requiresUserActivation: true,
    executionSurfaces: ['document'],
    supportsCancellation: true,
    maxConcurrency: 1,
    // EXAMPLE placeholder pending real-browser measurement (#93).
    expectedLatencyMs: 1_000,
    privacyBoundary: 'in-browser',
    allowedNetworkDestinations: ['none'],
    ...overrides,
  };
}

export function createBrowserBuiltInModelDescriptor(
  runtimeVersion = 'unknown',
  overrides: Partial<WorkerCapability> = {},
): BrowserBuiltInModelDescriptor {
  return {
    schemaVersion: BROWSER_BUILT_IN_MODEL_SCHEMA_VERSION,
    backend: 'browser-built-in-full-model',
    provider: 'chrome',
    api: 'prompt-api',
    runtimeVersion,
    capability: buildChromePromptApiCapability(runtimeVersion, overrides),
  };
}

/**
 * Validate a browser built-in model descriptor. Beyond shape checks, this:
 *   - runtime-validates the embedded typed `WorkerCapability`;
 *   - rejects any descriptor that tries to attach fabricated segment geometry
 *     to a backend that needs none (issue #102, preserved by #94);
 *   - rejects a capability that declares segment execution, which would
 *     contradict the full-model backend kind.
 */
export function validateBrowserBuiltInModelDescriptor(
  input: unknown,
  options: { supportedSchemaVersions?: readonly string[] } = {},
): BrowserBuiltInModelValidationResult {
  const issues: BrowserBuiltInModelValidationIssue[] = [];
  if (!isRecord(input)) {
    issues.push({ code: 'invalid-descriptor', path: '$', message: 'descriptor must be an object' });
    return { status: 'invalid', issues };
  }

  const supported = options.supportedSchemaVersions ?? [BROWSER_BUILT_IN_MODEL_SCHEMA_VERSION];
  if (typeof input.schemaVersion === 'string' && !supported.includes(input.schemaVersion)) {
    issues.push({
      code: 'unsupported-schema-version',
      path: '$.schemaVersion',
      message: `unsupported descriptor schema version: ${input.schemaVersion}`,
    });
  }
  if (input.backend !== 'browser-built-in-full-model') {
    issues.push({
      code: 'invalid-backend',
      path: '$.backend',
      message: "backend must be 'browser-built-in-full-model'",
    });
  }
  if (input.provider !== 'chrome') {
    issues.push({ code: 'invalid-provider', path: '$.provider', message: "provider must be 'chrome'" });
  }
  if (input.api !== 'prompt-api') {
    issues.push({ code: 'invalid-api', path: '$.api', message: "api must be 'prompt-api'" });
  }
  if (typeof input.runtimeVersion !== 'string' || input.runtimeVersion.trim().length === 0) {
    issues.push({
      code: 'invalid-runtime-version',
      path: '$.runtimeVersion',
      message: 'runtimeVersion must be a non-empty string',
    });
  }

  const capabilityValidation = validateWorkerCapability(input.capability);
  if (capabilityValidation.status !== 'valid') {
    issues.push({
      code: 'invalid-capability',
      path: '$.capability',
      message: `capability is not a valid WorkerCapability: ${capabilityValidation.issues
        .map((item) => `${item.path} ${item.code}`)
        .join('; ')}`,
    });
  } else if (
    isRecord(input.capability) &&
    (input.capability.backend !== 'browser-built-in-full-model' ||
      input.capability.executionMode === 'segment')
  ) {
    // A full-model descriptor whose embedded capability claims a different
    // backend kind or segment execution contradicts itself.
    issues.push({
      code: 'segment-execution-forbidden',
      path: '$.capability',
      message:
        'a browser-built-in full-model descriptor must carry a full-model capability ' +
        "(backend 'browser-built-in-full-model', executionMode 'full-model')",
    });
  }

  for (const field of FORBIDDEN_SEGMENT_GEOMETRY_FIELDS) {
    if (field in input) {
      issues.push({
        code: 'segment-geometry-forbidden',
        path: `$.${field}`,
        message: `browser-built-in full-model descriptor must not declare '${field}'`,
      });
    }
  }

  return { status: issues.length === 0 ? 'valid' : 'invalid', issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
