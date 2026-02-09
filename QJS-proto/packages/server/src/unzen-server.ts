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
import type { FunctionDefinition, ExecutionRequest } from '@unzen/shared';
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
   * Register a JavaScript function
   *
   * Extracts function source code using Function.prototype.toString()
   * and generates hash for integrity verification.
   *
   * @param name - Function name (used as identifier)
   * @param fn - JavaScript function to register
   */
  define(name: string, fn: Function): void {
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
   *
   * @param name - Function name (used as identifier)
   * @param code - JavaScript code as string (function expression or arrow function)
   */
  defineRaw(name: string, code: string): void {
    // Wrap code in run() function for client-side sandbox compatibility
    // Client expects to call `run(...args)` to execute the function
    const wrappedCode = `function run(...args) { return (${code})(...args); }`;

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

    // GET /manifest - Returns function manifest
    // This endpoint provides metadata about all registered functions
    app.get('/manifest', (c) => {
      const manifest = this.manifestBuilder.build();
      return c.json(manifest);
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
}
