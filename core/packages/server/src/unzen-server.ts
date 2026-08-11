/**
 * UnzenServer - Main server class for unzen core framework
 *
 * This class ties together all server components:
 * - FunctionRegistry: Stores function definitions
 * - ManifestBuilder: Generates manifest responses
 * - QuickJSRuntime: Provides fallback execution
 *
 * Design rationale:
 * - Version counter increments globally to ensure cache invalidation
 * - SHA-256 hash provides integrity verification for function code
 * - Function.toString() extracts source code from JavaScript functions
 * - Hono middleware provides HTTP endpoints for manifest, code, and execution
 */

import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { Hono } from 'hono';
import type {
  FunctionDefinition,
  ManifestResponse,
  MoonBitAbi,
} from '@unzen/shared';
import {
  createManifestResponse,
  createExecutionResponse,
  MAX_EXECUTION_ARGUMENTS,
  MAX_FUNCTION_PAYLOAD_BYTES,
  MAX_EXECUTION_REQUEST_BYTES,
  MAX_MANIFEST_RESPONSE_BYTES,
  UnzenFunctionError,
  UnzenRuntimeError,
  MAX_FUNCTION_TIMEOUT,
  isValidFunctionName,
  normalizeMoonBitAbi,
} from '@unzen/shared';
import { FunctionRegistry } from './function-registry';
import { ManifestBuilder } from './manifest-builder';
import { QuickJSRuntime } from './quickjs-runtime';
import { readBoundedJsonRequest, RequestBodyLimitError } from './request-body';

/**
 * Configuration options for UnzenServer
 */
export interface UnzenServerConfig {
  /** Base URL for code endpoints (e.g., 'https://example.com/unzen') */
  baseUrl?: string;
}

/** Execution policy attached to a registered QuickJS function. */
export interface UnzenFunctionOptions {
  /** Server fallback timeout in milliseconds (1-2000). */
  timeout?: number;
  /** Disable server fallback when browser execution cannot complete. */
  noFallback?: boolean;
}

const UNSUPPORTED_FUNCTION_TAGS = new Set([
  '[object AsyncFunction]',
  '[object GeneratorFunction]',
  '[object AsyncGeneratorFunction]',
]);

const RUN_FUNCTION_DECLARATION = /^function\s+run\s*\(/;

function assertSynchronousFunction(fn: Function): void {
  if (UNSUPPORTED_FUNCTION_TAGS.has(Object.prototype.toString.call(fn))) {
    throw new Error('Unzen define() supports synchronous non-generator functions only');
  }
}

function assertValidRegistrationName(name: unknown): asserts name is string {
  if (!isValidFunctionName(name)) {
    throw new Error(
      'Invalid function name: use 1-100 ASCII letters, numbers, underscores, or hyphens, starting with a letter',
    );
  }
}

function assertValidTimeout(timeout: unknown): asserts timeout is number | undefined {
  if (
    timeout !== undefined
    && (
      typeof timeout !== 'number'
      || !Number.isInteger(timeout)
      || timeout < 1
      || timeout > MAX_FUNCTION_TIMEOUT
    )
  ) {
    throw new Error(
      `Invalid timeout ${String(timeout)}: must be an integer between 1 and ${MAX_FUNCTION_TIMEOUT}ms`,
    );
  }
}

export class UnzenServer {
  private registry: FunctionRegistry;
  private manifestBuilder: ManifestBuilder;
  private baseUrl: string;
  private runtime: QuickJSRuntime;
  /** Versioned immutable payloads per {name, version, hash}, captured at
   * registration time. `code` is served verbatim for whatever runtime that
   * version was registered with (wasm bytes for moonbit, JS source for
   * quickjs), so a re-registration can never change what an already-published
   * ?v=N&h=HASH URL delivers. */
  private readonly versionedCode = new Map<string, Map<number, {
    runtime: 'quickjs' | 'moonbit';
    /** Content identity advertised in the manifest URL. */
    hash: string;
    /** JS source for quickjs, validated wasm bytes for moonbit */
    payload: Buffer;
  }>>();

  /**
   * Version counter that increments for each function registration
   * This ensures cache invalidation when functions are updated
   */
  private versionCounter: number = 0;

  /**
   * Create a new UnzenServer
   *
   * @param config - Server configuration
   */
  constructor(config: UnzenServerConfig = {}) {
    const baseUrl = config.baseUrl || 'http://localhost:3000';
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.registry = new FunctionRegistry();
    this.manifestBuilder = new ManifestBuilder(this.registry, this.baseUrl);
    this.runtime = new QuickJSRuntime();
  }

  /**
   * Initialize the server
   *
   * Must be called once after construction, before using middleware().
   * This initializes the QuickJS Wasm module (heavy operation done once at startup).
   */
  async initialize(): Promise<void> {
    await this.runtime.initialize();
  }

  /**
   * Register a JavaScript function with type-safe signature
   *
   * Extracts function source code using Function.prototype.toString()
   * and generates hash for integrity verification.
   * The function must execute synchronously and return a materialized value;
   * async and generator functions are rejected at registration.
   * Generic type parameters preserve argument/return type information
   * for better IDE support and compile-time checking.
   *
   * @param name - Function name (used as identifier)
   * @param fn - JavaScript function to register
   * @param options - Optional timeout and fallback policy
   */
  define<TArgs extends unknown[], TReturn>(
    name: string,
    fn: (...args: TArgs) => TReturn,
    options?: UnzenFunctionOptions,
  ): void {
    assertValidRegistrationName(name);
    assertSynchronousFunction(fn);
    // Extract function source code
    // Function.toString() returns the complete function definition as a string
    const code = fn.toString();

    // Use defineRaw to register with the extracted code
    this.defineRaw(name, code, options);
  }

  // MAX_FUNCTION_TIMEOUT is imported from @unzen/shared for single source of truth

  /**
   * Register a function from raw code string
   *
   * This is useful when you have the function code as a string
   * (e.g., loaded from file or generated dynamically).
   *
   * The code is wrapped in a `run()` function to match the client-side
   * sandbox convention where all functions are invoked via `run(...args)`.
   * If the code is already in `function run(...)` form, it is used as-is
   * to avoid double-wrapping which would break execution.
   *
   * @param name - Function name (used as identifier)
   * @param code - JavaScript code as string (function expression or arrow function)
   * @param options - Optional settings (timeout: 1-2000ms for heavy computations)
   */
  defineRaw(
    name: string,
    code: string,
    options?: UnzenFunctionOptions,
  ): void {
    assertValidRegistrationName(name);
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new Error('Function code must be a non-empty string');
    }
    const timeout = options?.timeout;
    const noFallback = options?.noFallback;
    assertValidTimeout(timeout);
    if (noFallback !== undefined && typeof noFallback !== 'boolean') {
      throw new Error('Invalid noFallback option: expected a boolean');
    }

    if (Buffer.byteLength(code, 'utf8') > MAX_FUNCTION_PAYLOAD_BYTES) {
      throw new Error(`Function code exceeds ${MAX_FUNCTION_PAYLOAD_BYTES} bytes`);
    }

    // If code is already in `function run(...)` form, use it directly
    // to avoid double-wrapping which would break execution.
    // e.g., wrapping `function run(x) { return x * 2; }` would produce
    // `function run(...args) { return (function run(x) { ... })(...args); }`
    // which creates an unnecessary nested call. Use trimStart() to handle
    // leading whitespace that might be present in template literals.
    // Otherwise, wrap in standard run() wrapper for client-side sandbox compatibility.
    const wrappedCode = RUN_FUNCTION_DECLARATION.test(code.trimStart())
      ? code
      : `function run(...args) { return (${code})(...args); }`;
    if (Buffer.byteLength(wrappedCode, 'utf8') > MAX_FUNCTION_PAYLOAD_BYTES) {
      throw new Error(`Function code exceeds ${MAX_FUNCTION_PAYLOAD_BYTES} bytes`);
    }

    const version = this.getNextVersion();

    // Generate SHA-256 hash of the wrapped code for integrity verification
    // This allows clients to verify that downloaded code matches the manifest
    const hash = this.generateHash(wrappedCode);

    // Create function definition
    // Include per-function timeout only if explicitly set (undefined = use default 50ms)
    const definition: FunctionDefinition = {
      name,
      runtime: 'quickjs', // Only QuickJS is supported in Phase 1 MVP
      code: wrappedCode,
      version,
      hash,
      ...(timeout !== undefined && { timeout }),
      ...(noFallback !== undefined && { noFallback }),
    };

    this.assertManifestWithinLimit(definition);
    // Warn only for definitions that passed every registration boundary.
    this.warnIfImpure(name, code);
    this.versionCounter = version;

    // Register the function definition
    this.captureVersionedCode(
      name,
      version,
      'quickjs',
      hash,
      Buffer.from(wrappedCode, 'utf-8'),
    );
    this.registry.register(definition);
  }

  /**
   * Register a MoonBit wasm-gc function from a compiled .wasm file.
   *
   * MoonBit functions are compiled to wasm-gc modules rather than JS source.
   * The manifest advertises them with runtime 'moonbit' and the code endpoint
   * serves the raw .wasm bytes; the browser executes the module's export.
   * Server-side fallback is NOT supported for MoonBit (the QuickJS runtime
   * cannot run wasm), so a failed browser attempt cannot fall back.
   *
   * @param name - Function name (used as identifier)
   * @param wasmPath - Filesystem path to the compiled .wasm module
   * @param options - Optional settings (exportName defaults to 'run', timeout, ABI)
   */
  defineMoonbit(
    name: string,
    wasmPath: string,
    options?: { exportName?: string; timeout?: number; abi?: MoonBitAbi },
  ): void {
    assertValidRegistrationName(name);
    if (typeof wasmPath !== 'string' || wasmPath.trim().length === 0) {
      throw new Error('MoonBit module path must be a non-empty string');
    }
    const timeout = options?.timeout;
    const exportName = options?.exportName;
    const requestedAbi = options?.abi;
    assertValidTimeout(timeout);
    if (exportName !== undefined && typeof exportName !== 'string') {
      throw new Error('Invalid MoonBit exportName: expected a string');
    }

    const moonbitAbi = requestedAbi === undefined
      ? undefined
      : normalizeMoonBitAbi(requestedAbi);
    if (requestedAbi !== undefined && moonbitAbi === undefined) {
      throw new Error('Invalid MoonBit ABI: expected params/result using scalar, i32[], or f64[]');
    }

    // Fail fast on declared size before reading the file into process memory.
    let declaredSize: number;
    try {
      declaredSize = statSync(wasmPath).size;
    } catch (error) {
      throw new Error(
        `Cannot read MoonBit module for "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (declaredSize > MAX_FUNCTION_PAYLOAD_BYTES) {
      throw new Error(`MoonBit module exceeds ${MAX_FUNCTION_PAYLOAD_BYTES} bytes`);
    }

    // The .wasm must exist and be a valid module at registration.
    let bytes: Buffer;
    try {
      bytes = readFileSync(wasmPath);
    } catch (error) {
      throw new Error(
        `Cannot read MoonBit module for "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Re-check the captured bytes in case the file changed after stat().
    if (bytes.byteLength > MAX_FUNCTION_PAYLOAD_BYTES) {
      throw new Error(`MoonBit module exceeds ${MAX_FUNCTION_PAYLOAD_BYTES} bytes`);
    }
    // Node's @types/node does not declare the WebAssembly global on the
    // server tsconfig (no DOM lib), so access it through the global object.
    const wasm = (globalThis as unknown as { WebAssembly?: { validate(b: Uint8Array): boolean } }).WebAssembly;
    if (!wasm || !wasm.validate(bytes)) {
      throw new Error(`MoonBit module for "${name}" failed WebAssembly validation`);
    }

    const version = this.getNextVersion();

    const definition: FunctionDefinition = {
      name,
      runtime: 'moonbit',
      // Server-side this holds the module path (the code endpoint reads the
      // bytes captured at registration); the manifest advertises the codeUrl
      // for browser fetches.
      code: wasmPath,
      version,
      hash: this.generateBytesHash(bytes),
      exportName: exportName ?? 'run',
      ...(moonbitAbi !== undefined && { moonbitAbi }),
      // The QuickJS server runtime cannot execute wasm-gc: browser-only.
      noFallback: true,
      ...(timeout !== undefined && { timeout }),
    };

    this.assertManifestWithinLimit(definition);
    this.versionCounter = version;

    // Capture the exact validated bytes for immutable delivery, keyed by
    // version so a re-registration with different bytes cannot change what an
    // already-published ?v=N&h=HASH URL delivers.
    this.captureVersionedCode(name, version, 'moonbit', definition.hash, bytes);
    this.registry.register(definition);
  }

  /** Return the next safe manifest version without mutating server state. */
  private getNextVersion(): number {
    const version = this.versionCounter + 1;
    if (!Number.isSafeInteger(version)) {
      throw new Error('Function version counter exhausted');
    }
    return version;
  }

  /** Ensure a candidate registration remains readable by every Core client. */
  private assertManifestWithinLimit(candidate: FunctionDefinition): void {
    const definitions = this.registry.getAll();
    definitions.set(candidate.name, candidate);
    const record = Object.create(null) as Record<string, FunctionDefinition>;
    for (const [name, definition] of definitions) {
      record[name] = definition;
    }
    const manifest = createManifestResponse(record, this.baseUrl);
    const body = JSON.stringify(manifest);
    if (Buffer.byteLength(body, 'utf8') > MAX_MANIFEST_RESPONSE_BYTES) {
      throw new Error(`Manifest exceeds ${MAX_MANIFEST_RESPONSE_BYTES} bytes`);
    }
  }

  /** Record the exact payload served by a published ?v=N&h=HASH URL. */
  private captureVersionedCode(
    name: string,
    version: number,
    runtime: 'quickjs' | 'moonbit',
    hash: string,
    payload: Buffer,
  ): void {
    const byVersion = this.versionedCode.get(name) ?? new Map();
    byVersion.set(version, { runtime, hash, payload });
    this.versionedCode.set(name, byVersion);
  }

  /**
   * Get a registered function definition by name
   *
   * @param name - Function name
   * @returns Function definition if found, undefined otherwise
   */
  getFunction(name: string): FunctionDefinition | undefined {
    return this.registry.get(name);
  }

  /**
   * Get Hono middleware handler
   *
   * Returns a Hono middleware that provides HTTP endpoints:
   * - GET /manifest: Returns manifest with all function metadata
   * - GET /code/:name: Returns function code
   * - POST /exec/:name: Executes function server-side (fallback)
   *
   * @returns Hono middleware handler
   */
  middleware(): Hono {
    const app = new Hono();

    // GET /manifest - Returns function manifest with ETag caching
    // This endpoint provides metadata about all registered functions.
    // ETag support allows clients to send conditional requests via If-None-Match
    // header, receiving 304 Not Modified when the manifest hasn't changed.
    // This saves bandwidth and client-side JSON parsing for unchanged manifests.
    app.get('/manifest', (c) => {
      const manifest = this.manifestBuilder.build();
      const body = JSON.stringify(manifest);
      const bodyBytes = Buffer.byteLength(body, 'utf8');
      if (bodyBytes > MAX_MANIFEST_RESPONSE_BYTES) {
        return c.json({ error: 'Manifest exceeds the configured response limit' }, 500, {
          'Cache-Control': 'no-store',
        });
      }
      const etag = this.generateManifestETag(manifest);

      // Check If-None-Match header for conditional request (RFC 7232)
      // If the client's cached ETag matches the current manifest ETag,
      // respond with 304 to avoid re-transmitting the same data.
      // RFC 7232 Section 4.1 requires 304 to include ETag header.
      const ifNoneMatch = c.req.header('If-None-Match');
      if (ifNoneMatch === etag) {
        return c.body(null, 304, {
          'ETag': etag,
          'Cache-Control': 'no-cache',
          'Content-Length': String(bodyBytes),
        });
      }

      // Cache-Control: no-cache allows caching but requires revalidation
      // with the origin server before using a cached copy. This ensures
      // clients always get a fresh or validated manifest via ETag check.
      return c.body(body, 200, {
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': String(bodyBytes),
        'ETag': etag,
        'Cache-Control': 'no-cache',
      });
    });

    // GET /code/:name - Returns function code
    // This endpoint serves the actual function source code
    // Code is immutable (versioned), so we set aggressive cache headers
    app.get('/code/:name', (c) => {
      const name = c.req.param('name');
      const fn = this.registry.get(name);

      if (!fn) {
        return c.json({ error: 'Function not found' }, 404);
      }

      // Set cache headers for immutable content. Version + SHA-256 query
      // parameters ensure cache invalidation both within a process and across
      // restarts where the numeric counter may reset.
      // Resolve the versioned immutable payload FIRST, independent of the
      // current registry runtime: a same-name re-registration (moonbit→quickjs
      // or quickjs→moonbit) must not change what an already-published
      // ?v=N&h=HASH URL
      // delivers. An EXPLICIT version must exist in the versioned store — an
      // unknown version is a 404 (never serve the current code under a stale
      // immutable URL, which would poison CDN caches). Only a MISSING ?v=
      // resolves to the current registry version.
      const rawVersion = c.req.query('v');
      const rawHash = c.req.query('h');
      if (rawVersion === undefined && rawHash !== undefined) {
        return c.json({ error: 'Hash requires an explicit version' }, 400, {
          'Cache-Control': 'no-store',
        });
      }
      let version = fn.version;
      if (rawVersion !== undefined) {
        const parsedVersion = Number(rawVersion);
        if (
          !/^[1-9][0-9]*$/.test(rawVersion)
          || !Number.isSafeInteger(parsedVersion)
        ) {
          return c.json({ error: 'Invalid version' }, 400, {
            'Cache-Control': 'no-store',
          });
        }
        version = parsedVersion;
      }
      const byVersion = this.versionedCode.get(name);
      const entry = byVersion?.get(version);
      if (entry) {
        if (rawHash !== undefined && rawHash !== entry.hash) {
          return c.body(null, 404, { 'Cache-Control': 'no-store' });
        }
        const isWasm = entry.runtime === 'moonbit';
        const hasImmutableIdentity = rawVersion !== undefined && rawHash === entry.hash;
        return c.body(Uint8Array.from(entry.payload), 200, {
          'Content-Type': isWasm ? 'application/wasm' : 'text/javascript; charset=utf-8',
          'Content-Length': String(entry.payload.byteLength),
          // Only an explicit version + matching content hash is immutable.
          // Legacy ?v=N URLs still resolve, but must revalidate because that
          // numeric identity can be reused after a server restart.
          'Cache-Control': hasImmutableIdentity
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        });
      }
      if (rawVersion !== undefined) {
        // Explicit version that was never published (or lost on restart):
        // never fall back to current code under an immutable URL.
        return c.body(null, 404, { 'Cache-Control': 'no-store' });
      }
      // No ?v= and no captured versioned payload (e.g. server restarted):
      // serve the current registry code.
      if (fn.runtime === 'moonbit') {
        return c.json({ error: 'MoonBit module not found' }, 500);
      }
      return c.text(fn.code, 200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(fn.code, 'utf8')),
        // No explicit ?v=: the URL can resolve to a NEWER version after a
        // re-registration, so it must not be cached as immutable.
        'Cache-Control': 'no-cache',
      });
    });

    // POST /exec/:name - Executes function server-side (fallback)
    // This endpoint provides server-side execution when browser execution fails
    app.post('/exec/:name', async (c) => {
      const name = c.req.param('name');
      const fn = this.registry.get(name);

      if (!fn) {
        return c.json(
          createExecutionResponse({
            success: false,
            error: 'Function not found',
          }),
          404
        );
      }

      // Functions marked noFallback (MoonBit wasm-gc, or privacy-sensitive
      // functions like password hashing) execute in the browser only — the
      // server never receives their inputs or provides fallback execution.
      if (fn.noFallback || fn.runtime === 'moonbit') {
        return c.json(
          createExecutionResponse({
            success: false,
            error: 'This function requires browser execution (server fallback is disabled)',
          }),
          501
        );
      }

      try {
        // Parse request body with JSON error handling (H2 fix)
        let body: unknown;
        try {
          body = await readBoundedJsonRequest(
            c.req.raw,
            MAX_EXECUTION_REQUEST_BYTES,
            'Fallback request',
          );
        } catch (error) {
          if (error instanceof RequestBodyLimitError) {
            return c.json(
              createExecutionResponse({
                success: false,
                error: error.message,
              }),
              413,
            );
          }
          return c.json(
            createExecutionResponse({
              success: false,
              error: 'Invalid JSON in request body',
            }),
            400
          );
        }

        // Validate args field: must be an array with bounded length (H2 fix)
        // Without validation, non-array args cause runtime errors (DoS vector)
        // and unbounded arrays consume excessive memory
        if (
          typeof body !== 'object'
          || body === null
          || Array.isArray(body)
          || !Array.isArray((body as Record<string, unknown>).args)
        ) {
          return c.json(
            createExecutionResponse({
              success: false,
              error: 'Request body must contain "args" array',
            }),
            400
          );
        }
        const args = (body as { args: unknown[] }).args;
        // The shared bound is generous; no legitimate function needs more.
        if (args.length > MAX_EXECUTION_ARGUMENTS) {
          return c.json(
            createExecutionResponse({
              success: false,
              error: `Too many arguments (max ${MAX_EXECUTION_ARGUMENTS})`,
            }),
            400
          );
        }

        // Execute the function using shared runtime
        // The runtime creates a fresh context for each execution to ensure isolation
        // Pass per-function timeout if set; otherwise runtime uses default 50ms
        const result = await this.runtime.execute(fn.code, args,
          fn.timeout !== undefined ? { timeout: fn.timeout } : undefined
        );

        return c.json(
          createExecutionResponse({
            success: true,
            result,
          })
        );
      } catch (error) {
        // Distinguish between function errors and runtime errors
        // UnzenFunctionError: User code bugs (syntax/runtime errors) → HTTP 400
        // UnzenRuntimeError: Runtime problems (timeout, disposed) → HTTP 500
        // Other errors: Unknown issues → HTTP 500
        //
        // H3 fix: Sanitize error messages to prevent information leakage.
        // Only UnzenFunctionError exposes the message (user's own code error).
        // Runtime and unknown errors get generic messages.
        let errorMessage: string;
        let statusCode: number;

        if (error instanceof UnzenFunctionError) {
          // Sanitize function error: extract only the user-facing message,
          // strip any JSON-serialized QuickJS error objects containing stack traces
          errorMessage = this.sanitizeErrorMessage(error.message);
          statusCode = 400; // Client error - user code bug
        } else if (error instanceof UnzenRuntimeError) {
          // Generic message for runtime errors — don't expose timeout config etc.
          errorMessage = 'Server execution failed';
          statusCode = 500; // Server error - runtime problem
        } else {
          // Generic message for unknown errors — don't expose internals
          errorMessage = 'Internal server error';
          statusCode = 500; // Server error - unknown issue
        }

        return c.json(
          createExecutionResponse({
            success: false,
            error: errorMessage,
          }),
          statusCode as 400 | 500
        );
      }
    });

    return app;
  }

  /**
   * Patterns that indicate non-pure API usage in function code.
   * These APIs require network/system access that the QuickJS sandbox blocks.
   * Each pattern uses word boundary (\b) to avoid false positives on
   * substrings (e.g., "prefetch" won't match "fetch(").
   */
  private static readonly IMPURE_PATTERNS = [
    { pattern: /\bfetch\s*\(/, name: 'fetch(' },
    { pattern: /\bXMLHttpRequest\b/, name: 'XMLHttpRequest' },
    { pattern: /\bimport\s*\(/, name: 'import(' },
    { pattern: /\bWebSocket\b/, name: 'WebSocket' },
  ];

  /**
   * Warn if function code contains APIs that won't work in sandbox.
   * These APIs require network/system access that the sandbox blocks.
   * Warning only (not error) because the code might reference these
   * as strings or in comments -- we can't reliably distinguish usage
   * from mention without full AST parsing.
   *
   * @param name - Function name for context in warning message
   * @param code - Function source code to check
   */
  private warnIfImpure(name: string, code: string): void {
    for (const { pattern, name: apiName } of UnzenServer.IMPURE_PATTERNS) {
      if (pattern.test(code)) {
        console.warn(
          `[unzen] Function "${name}" contains ${apiName} which will not work in the sandbox. ` +
            `Sandbox functions should be pure computations without network/system access.`
        );
      }
    }
  }

  /**
   * Sanitize error messages for HTTP responses (H3 fix)
   *
   * Strips internal details like stack traces, file paths, and
   * JSON-serialized QuickJS error objects from error messages.
   * Only preserves the human-readable error description.
   *
   * @param message - Raw error message from QuickJS runtime
   * @returns Sanitized message safe for HTTP response
   */
  private sanitizeErrorMessage(message: string): string {
    // QuickJS wraps errors as JSON: 'Function execution failed: {"name":"Error","message":"...","stack":"..."}'
    // Extract just the user-visible message from the JSON
    const jsonMatch = message.match(/:\s*(\{.*\})$/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed.message) {
          return `Function error: ${parsed.message}`;
        }
      } catch {
        // JSON parse failed, fall through to generic sanitization
      }
    }

    // Strip file paths, stack traces, and other internal details
    const sanitized = message
      .replace(/\s+at\s+.*/g, '') // Remove stack trace lines
      .replace(/[A-Z]:\\[^\s]*/g, '[path]') // Redact Windows paths (C:\Users\...)
      .replace(/\/[^\s]*\.[jt]sx?/g, '[path]') // Redact Unix paths with JS/TS extensions
      .replace(/\/(Users|home|var|tmp|etc|opt|usr)[^\s]*/g, '[path]') // Redact common Unix paths
      .trim();

    return sanitized || 'Function execution failed';
  }

  /**
   * Generate SHA-256 hash of code string
   *
   * Used for integrity verification to ensure downloaded code
   * matches the manifest entry.
   *
   * @param code - Code string to hash
   * @returns SHA-256 hash prefixed with 'sha256:'
   */
  private generateHash(code: string): string {
    const hash = createHash('sha256').update(code).digest('hex');
    return `sha256:${hash}`;
  }

  /**
   * Generate SHA-256 hash of raw module bytes (MoonBit wasm).
   * Hashes the exact bytes that will be served, so a client can verify the
   * delivered module against the manifest hash.
   */
  private generateBytesHash(bytes: Buffer): string {
    const hash = createHash('sha256').update(bytes).digest('hex');
    return `sha256:${hash}`;
  }

  /**
   * Generate ETag for the current manifest state (Phase 3 ETag caching)
   *
   * Combines all function hashes and versions into a single SHA-256 digest.
   * Uses Weak ETag (W/"...") since the manifest is semantically equivalent
   * across different JSON serializations (key ordering may vary).
   *
   * The ETag is deterministic: same set of functions with same hashes/versions
   * always produces the same ETag, regardless of registration order.
   * This is achieved by sorting function names alphabetically before hashing.
   *
   * @param manifest - Current manifest response
   * @returns Weak ETag string in format W/"<64-char hex>"
   */
  private generateManifestETag(manifest: ManifestResponse): string {
    const hash = createHash('sha256');
    // Sort function names for deterministic ordering
    // Without sorting, the same set of functions registered in different
    // orders would produce different ETags, causing unnecessary cache misses
    const sortedNames = Object.keys(manifest.functions).sort();
    for (const name of sortedNames) {
      const entry = manifest.functions[name];
      // Include name, hash, and version in the digest to detect any change
      hash.update(`${name}:${entry.hash}:${entry.version}`);
    }
    // Use full SHA-256 (256 bits) for maximum collision resistance.
    // Truncated ETags (64-bit) risk birthday collisions at ~2^32 manifests.
    // Weak ETag (W/ prefix) is appropriate because JSON serialization
    // of the same manifest could vary (key ordering, whitespace).
    return `W/"${hash.digest('hex')}"`;
  }
}
