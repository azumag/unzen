/**
 * UnzenServer - Main server class for QJS-proto framework
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
import { Hono } from 'hono';
import type { FunctionDefinition, ExecutionRequest, ManifestResponse } from '@unzen/shared';
import { createExecutionResponse, UnzenFunctionError, UnzenRuntimeError } from '@unzen/shared';
import { FunctionRegistry } from './function-registry';
import { ManifestBuilder } from './manifest-builder';
import { QuickJSRuntime } from './quickjs-runtime';

/**
 * Configuration options for UnzenServer
 */
export interface UnzenServerConfig {
  /** Base URL for code endpoints (e.g., 'https://example.com/unzen') */
  baseUrl?: string;
}

export class UnzenServer {
  private registry: FunctionRegistry;
  private manifestBuilder: ManifestBuilder;
  private baseUrl: string;
  private runtime: QuickJSRuntime;

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
    this.baseUrl = config.baseUrl || 'http://localhost:3000';
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
   * Generic type parameters preserve argument/return type information
   * for better IDE support and compile-time checking.
   *
   * @param name - Function name (used as identifier)
   * @param fn - JavaScript function to register
   */
  define<TArgs extends unknown[], TReturn>(
    name: string,
    fn: (...args: TArgs) => TReturn
  ): void {
    // Extract function source code
    // Function.toString() returns the complete function definition as a string
    const code = fn.toString();

    // Use defineRaw to register with the extracted code
    this.defineRaw(name, code);
  }

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
   */
  defineRaw(name: string, code: string): void {
    // Warn if function code contains non-pure APIs that won't work in sandbox
    // This is a DX convenience: developers get early feedback during registration
    // rather than cryptic runtime errors in the sandbox
    this.warnIfImpure(name, code);

    // If code is already in `function run(...)` form, use it directly
    // to avoid double-wrapping which would break execution.
    // e.g., wrapping `function run(x) { return x * 2; }` would produce
    // `function run(...args) { return (function run(x) { ... })(...args); }`
    // which creates an unnecessary nested call. Use trimStart() to handle
    // leading whitespace that might be present in template literals.
    // Otherwise, wrap in standard run() wrapper for client-side sandbox compatibility.
    const wrappedCode = code.trimStart().startsWith('function run')
      ? code
      : `function run(...args) { return (${code})(...args); }`;

    // Increment version counter for this registration
    // This ensures each function registration gets a unique version
    this.versionCounter++;

    // Generate SHA-256 hash of the wrapped code for integrity verification
    // This allows clients to verify that downloaded code matches the manifest
    const hash = this.generateHash(wrappedCode);

    // Create function definition
    const definition: FunctionDefinition = {
      name,
      runtime: 'quickjs', // Only QuickJS is supported in Phase 1 MVP
      code: wrappedCode,
      version: this.versionCounter,
      hash,
    };

    // Register the function definition
    this.registry.register(definition);
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
        });
      }

      // Cache-Control: no-cache allows caching but requires revalidation
      // with the origin server before using a cached copy. This ensures
      // clients always get a fresh or validated manifest via ETag check.
      return c.json(manifest, 200, {
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

      // Set cache headers for immutable content
      // Version query parameter (?v=N) ensures cache invalidation on updates
      return c.text(fn.code, 200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
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

      try {
        // Parse request body with JSON error handling (H2 fix)
        let body: ExecutionRequest;
        try {
          body = await c.req.json<ExecutionRequest>();
        } catch {
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
        if (!Array.isArray(body.args)) {
          return c.json(
            createExecutionResponse({
              success: false,
              error: 'Request body must contain "args" array',
            }),
            400
          );
        }
        // 128 args is a generous upper bound; no legitimate function needs more
        if (body.args.length > 128) {
          return c.json(
            createExecutionResponse({
              success: false,
              error: 'Too many arguments (max 128)',
            }),
            400
          );
        }

        // Execute the function using shared runtime
        // The runtime creates a fresh context for each execution to ensure isolation
        const result = await this.runtime.execute(fn.code, body.args);

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
