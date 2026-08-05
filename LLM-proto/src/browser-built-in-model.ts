/**
 * Chrome Built-in AI full-model backend descriptor (issue #92, #102).
 *
 * The Chrome backend runs one full model inside the document's Prompt API
 * session. It has NO segment geometry, NO artifact hashes, and NO VRAM
 * partitioning: every segmented-model field is absent by construction, and the
 * validator rejects any descriptor that fabricates them.
 */

export const BROWSER_BUILT_IN_MODEL_SCHEMA_VERSION = '1.0.0' as const;

export interface BrowserBuiltInModelDescriptor {
  readonly schemaVersion: string;
  readonly backend: 'browser-built-in-full-model';
  readonly provider: 'chrome';
  readonly api: 'prompt-api';
  readonly runtimeVersion: string;
  readonly capabilities: readonly string[];
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

export function createBrowserBuiltInModelDescriptor(
  runtimeVersion = 'unknown',
): BrowserBuiltInModelDescriptor {
  return {
    schemaVersion: BROWSER_BUILT_IN_MODEL_SCHEMA_VERSION,
    backend: 'browser-built-in-full-model',
    provider: 'chrome',
    api: 'prompt-api',
    runtimeVersion,
    capabilities: ['full-model-in-document', 'streaming', 'abort', 'context-window'],
  };
}

/**
 * Validate a browser built-in model descriptor. Beyond shape checks, this
 * rejects any descriptor that tries to attach fabricated segment geometry to a
 * backend that needs none.
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
  if (
    !Array.isArray(input.capabilities) ||
    input.capabilities.length === 0 ||
    !input.capabilities.every((value) => typeof value === 'string' && value.trim().length > 0)
  ) {
    issues.push({
      code: 'invalid-capabilities',
      path: '$.capabilities',
      message: 'capabilities must be a non-empty array of strings',
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
