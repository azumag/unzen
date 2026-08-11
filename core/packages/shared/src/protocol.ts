/**
 * Protocol definitions for client-server communication
 *
 * Defines the HTTP API contract between client and server.
 * All messages are JSON-serializable for transmission over HTTP.
 */

import {
  isRuntimeType,
  isValidContentHash,
  isValidFunctionName,
  normalizeFunctionDefinition,
  normalizeMoonBitAbi,
} from './types';
export { MAX_FUNCTION_PAYLOAD_BYTES } from './types';
import type { FunctionDefinition, MoonBitAbi, RuntimeType } from './types';
import { exceedsUtf8ByteLength, utf8ByteLength } from './utf8';

/**
 * Request type for fetching the function manifest
 *
 * Empty request - all information is in the URL path
 */
export interface ManifestRequest {}

/** Maximum encoded JSON size accepted for a manifest response (1 MiB). */
export const MAX_MANIFEST_RESPONSE_BYTES = 1024 * 1024;

/** Maximum encoded JSON size accepted for one fallback response (16 MiB). */
export const MAX_EXECUTION_RESPONSE_BYTES = 16 * 1024 * 1024;

const MAX_MANIFEST_BASE_URL_BYTES = 2048;
const RELATIVE_MANIFEST_BASE_ORIGIN = 'https://unzen.invalid';

function invalidManifestBaseUrl(): TypeError {
  return new TypeError(
    'baseUrl must be an HTTP(S) URL or an origin-relative path without credentials, query, or fragment',
  );
}

function normalizeManifestBaseUrl(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || exceedsUtf8ByteLength(value.trim(), MAX_MANIFEST_BASE_URL_BYTES)
  ) {
    throw invalidManifestBaseUrl();
  }
  const trimmed = value.trim();

  try {
    if (trimmed.startsWith('/')) {
      if (trimmed.startsWith('//')) throw invalidManifestBaseUrl();
      const parsed = new URL(trimmed, `${RELATIVE_MANIFEST_BASE_ORIGIN}/`);
      if (
        parsed.origin !== RELATIVE_MANIFEST_BASE_ORIGIN
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.search !== ''
        || parsed.hash !== ''
      ) {
        throw invalidManifestBaseUrl();
      }
      return parsed.pathname.replace(/\/+$/, '');
    }

    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.search !== ''
      || parsed.hash !== ''
    ) {
      throw invalidManifestBaseUrl();
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('baseUrl must')) {
      throw error;
    }
    throw invalidManifestBaseUrl();
  }
}

/**
 * Response type for manifest endpoint
 *
 * Returns metadata about all available functions including
 * their runtime type, version, hash, and URL for fetching code.
 */
export interface ManifestResponse {
  /** Map of function name to manifest entry */
  functions: Record<string, FunctionManifestEntry>;
}

/**
 * Single function entry in the manifest
 *
 * Contains all metadata needed to fetch and execute a function.
 */
export interface FunctionManifestEntry {
  /** Runtime type that can execute this function */
  runtime: RuntimeType;
  /** SHA-256 hash of function code for integrity verification */
  hash: string;
  /** Version number for cache invalidation */
  version: number;
  /** URL to fetch the function code (immutable, cacheable) */
  codeUrl: string;
  /** Name of the export to call on a MoonBit wasm-gc module (defaults to 'run') */
  exportName?: string;
  /** Optional MoonBit array-copy ABI for this export. */
  moonbitAbi?: MoonBitAbi;
  /** When true, a browser failure never falls back to the server. */
  noFallback?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFetchableCodeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    return false;
  }
  try {
    // The server may emit either an absolute URL or an origin-relative URL.
    // A fixed HTTPS base lets the URL parser validate both without depending
    // on a browser location.
    const parsed = new URL(value, 'https://unzen.invalid/');
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.hash === ''
    );
  } catch {
    return false;
  }
}

/**
 * Validate and copy an untrusted manifest response.
 *
 * The returned function table has a null prototype, so names such as
 * `toString` cannot be mistaken for entries inherited from Object.prototype.
 * Unknown fields are ignored to preserve forward compatibility.
 */
export function normalizeManifestResponse(value: unknown): ManifestResponse | undefined {
  try {
    if (!isRecord(value) || !Object.hasOwn(value, 'functions')) return undefined;
    const sourceFunctions = value.functions;
    if (!isRecord(sourceFunctions)) return undefined;

    const functions = Object.create(null) as Record<string, FunctionManifestEntry>;
    for (const name of Object.keys(sourceFunctions)) {
      if (!isValidFunctionName(name)) return undefined;

      const sourceEntry = sourceFunctions[name];
      if (!isRecord(sourceEntry)) return undefined;
      if (
        !Object.hasOwn(sourceEntry, 'runtime')
        || !Object.hasOwn(sourceEntry, 'hash')
        || !Object.hasOwn(sourceEntry, 'version')
        || !Object.hasOwn(sourceEntry, 'codeUrl')
      ) {
        return undefined;
      }

      const runtime = sourceEntry.runtime;
      const hash = sourceEntry.hash;
      const version = sourceEntry.version;
      const codeUrl = sourceEntry.codeUrl;
      if (
        !isRuntimeType(runtime)
        || !isValidContentHash(hash)
        || typeof version !== 'number'
        || !Number.isSafeInteger(version)
        || version <= 0
        || !isFetchableCodeUrl(codeUrl)
      ) {
        return undefined;
      }

      const exportName = Object.hasOwn(sourceEntry, 'exportName')
        ? sourceEntry.exportName
        : undefined;
      if (
        exportName !== undefined
        && (runtime !== 'moonbit' || typeof exportName !== 'string')
      ) {
        return undefined;
      }

      const sourceMoonbitAbi = Object.hasOwn(sourceEntry, 'moonbitAbi')
        ? sourceEntry.moonbitAbi
        : undefined;
      const moonbitAbi = sourceMoonbitAbi === undefined
        ? undefined
        : normalizeMoonBitAbi(sourceMoonbitAbi);
      if (
        sourceMoonbitAbi !== undefined
        && (runtime !== 'moonbit' || moonbitAbi === undefined)
      ) {
        return undefined;
      }

      const noFallback = Object.hasOwn(sourceEntry, 'noFallback')
        ? sourceEntry.noFallback
        : undefined;
      if (noFallback !== undefined && typeof noFallback !== 'boolean') {
        return undefined;
      }

      functions[name] = {
        runtime,
        hash,
        version,
        codeUrl,
        ...(exportName !== undefined && { exportName }),
        ...(moonbitAbi !== undefined && { moonbitAbi }),
        ...(noFallback !== undefined && { noFallback }),
      };
    }

    return { functions };
  } catch {
    return undefined;
  }
}

/** Runtime type guard for data received from a manifest endpoint. */
export function isValidManifestResponse(value: unknown): value is ManifestResponse {
  return normalizeManifestResponse(value) !== undefined;
}

/**
 * Request type for function execution (fallback API)
 *
 * Used when browser execution fails and server fallback is needed.
 */
export interface ExecutionRequest {
  /** Arguments to pass to the function (bounded by MAX_EXECUTION_ARGUMENTS). */
  args: unknown[];
}

/** Maximum number of arguments accepted by the fallback transport. */
export const MAX_EXECUTION_ARGUMENTS = 128;

/** Maximum encoded JSON size accepted for one fallback request (4 MiB). */
export const MAX_EXECUTION_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * Response type for function execution (fallback API)
 *
 * Contains either the result or error from server-side execution.
 */
export type ExecutionResponse =
  | {
      /** Function return value. */
      result: unknown;
      error?: never;
    }
  | {
      /** Error responses use null because the fallback transport is JSON. */
      result: null;
      /** Sanitized non-empty error message. */
      error: string;
    };

/**
 * Validate the fallback response envelope without constraining its result.
 *
 * An empty object is retained as the legacy wire representation of a
 * successful `undefined` result (`JSON.stringify` omits that property).
 */
export function normalizeExecutionResponse(value: unknown): ExecutionResponse | undefined {
  try {
    if (!isRecord(value)) return undefined;

    if (Object.hasOwn(value, 'error')) {
      const error = value.error;
      if (typeof error !== 'string' || error.trim().length === 0) return undefined;
      if (!Object.hasOwn(value, 'result') || value.result !== null) return undefined;
      return { result: null, error };
    }

    if (!Object.hasOwn(value, 'result') && Reflect.ownKeys(value).length !== 0) {
      return undefined;
    }
    return {
      result: Object.hasOwn(value, 'result') ? value.result : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Runtime type guard for a fallback execution response. */
export function isValidExecutionResponse(value: unknown): value is ExecutionResponse {
  return normalizeExecutionResponse(value) !== undefined;
}

/**
 * Helper function to create manifest response from function definitions
 *
 * Converts internal function definitions to manifest entries with
 * appropriate code URLs.
 *
 * @param functions - Map of function name to definition
 * @param baseUrl - Base URL for code endpoints (e.g., 'https://example.com/unzen')
 * @returns Manifest response ready for JSON serialization
 *
 * @example
 * ```ts
 * const functions = {
 *   spamCheck: {
 *     name: 'spamCheck',
 *     runtime: 'quickjs',
 *     code: 'return /spam/i.test(args[0])',
 *     version: 1,
 *     hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 *   },
 * };
 *
 * const response = createManifestResponse(functions, 'https://example.com/unzen');
 * // {
 * //   functions: {
 * //     spamCheck: {
 * //       runtime: 'quickjs',
 * //       hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 * //       version: 1,
 * //       codeUrl: 'https://example.com/unzen/code/spamCheck?v=1&h=sha256%3Aaaaaaaaa...',
 * //     },
 * //   },
 * // }
 * ```
 */
export function createManifestResponse(
  functions: Record<string, FunctionDefinition>,
  baseUrl: string
): ManifestResponse {
  let names: string[];
  try {
    if (!isRecord(functions)) {
      throw new TypeError('Invalid manifest function definitions');
    }
    names = Object.keys(functions);
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Invalid manifest function definitions') {
      throw error;
    }
    throw new TypeError('Manifest function definitions could not be read');
  }

  const normalizedBaseUrl = normalizeManifestBaseUrl(baseUrl);
  const functionEntries = Object.create(null) as Record<string, FunctionManifestEntry>;
  const result: ManifestResponse = { functions: functionEntries };
  let manifestBytes = utf8ByteLength('{"functions":{}}');
  let firstEntry = true;

  for (const name of names) {
    const definition = normalizeFunctionDefinition(functions[name]);
    if (definition === undefined || definition.name !== name) {
      throw new TypeError(`Invalid function definition for "${name}"`);
    }
    if (
      definition.exportName !== undefined
      && exceedsUtf8ByteLength(definition.exportName, MAX_MANIFEST_RESPONSE_BYTES)
    ) {
      throw new Error(`Manifest exceeds ${MAX_MANIFEST_RESPONSE_BYTES} bytes`);
    }

    const entry: FunctionManifestEntry = {
      runtime: definition.runtime,
      hash: definition.hash,
      version: definition.version,
      // Both values are required for persistent cache identity. The numeric
      // version distinguishes registrations within one server process; the
      // content hash keeps the URL unique across restarts/deployments where
      // version counters may start again from 1.
      codeUrl: `${normalizedBaseUrl}/code/${name}?v=${definition.version}`
        + `&h=${encodeURIComponent(definition.hash)}`,
      // MoonBit modules may export under their pub fn name rather than 'run'
      ...(definition.exportName !== undefined && { exportName: definition.exportName }),
      ...(definition.moonbitAbi !== undefined && { moonbitAbi: definition.moonbitAbi }),
      ...(definition.noFallback !== undefined && { noFallback: definition.noFallback }),
    };

    const property = `${firstEntry ? '' : ','}${JSON.stringify(name)}:${JSON.stringify(entry)}`;
    manifestBytes += utf8ByteLength(
      property,
      MAX_MANIFEST_RESPONSE_BYTES - manifestBytes,
    );
    if (manifestBytes > MAX_MANIFEST_RESPONSE_BYTES) {
      throw new Error(`Manifest exceeds ${MAX_MANIFEST_RESPONSE_BYTES} bytes`);
    }
    functionEntries[name] = entry;
    firstEntry = false;
  }

  return result;
}

/**
 * Helper function to create execution response
 *
 * Creates a properly structured response for either success or failure cases.
 *
 * @param outcome - Execution outcome (success with result, or failure with error)
 * @returns Execution response ready for JSON serialization
 *
 * @example
 * ```ts
 * // Success case
 * const successResponse = createExecutionResponse({
 *   success: true,
 *   result: 42,
 * });
 * // { result: 42 }
 *
 * // Error case
 * const errorResponse = createExecutionResponse({
 *   success: false,
 *   error: 'Timeout exceeded',
 * });
 * // { result: null, error: 'Timeout exceeded' }
 * ```
 */
export function createExecutionResponse(
  outcome: { success: true; result: unknown } | { success: false; error: string }
): ExecutionResponse {
  if (outcome.success) {
    return { result: outcome.result };
  } else {
    return { result: null, error: outcome.error };
  }
}
