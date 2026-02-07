/**
 * ManifestBuilder - Builds manifest response from function registry
 *
 * This class converts internal function definitions into the manifest format
 * expected by clients. It uses the createManifestResponse helper from @unzen/shared
 * to ensure consistent format.
 *
 * Design rationale:
 * - Separates manifest building logic from registry storage
 * - Normalizes baseUrl to handle trailing slashes consistently
 * - Delegates to shared protocol helpers for consistent API contract
 */

import { createManifestResponse, type ManifestResponse, type FunctionDefinition } from '@unzen/shared';
import type { FunctionRegistry } from './function-registry';

export class ManifestBuilder {
  private registry: FunctionRegistry;
  private baseUrl: string;

  /**
   * Create a new ManifestBuilder
   *
   * @param registry - Function registry to build manifest from
   * @param baseUrl - Base URL for code endpoints (trailing slash will be normalized)
   */
  constructor(registry: FunctionRegistry, baseUrl: string) {
    this.registry = registry;
    // Normalize baseUrl by removing trailing slash if present
    // This ensures consistent URL construction regardless of input format
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  /**
   * Build manifest response from current registry state
   *
   * Converts all registered functions into manifest format with code URLs.
   * Uses createManifestResponse from @unzen/shared to ensure consistent format.
   *
   * @returns Manifest response ready for JSON serialization
   */
  build(): ManifestResponse {
    // Get all functions from registry as a Record for createManifestResponse
    const functionsMap = this.registry.getAll();
    const functionsRecord: Record<string, FunctionDefinition> = {};

    for (const [name, def] of functionsMap) {
      functionsRecord[name] = def;
    }

    // Use shared protocol helper to build manifest response
    // This ensures consistent format between server and client expectations
    return createManifestResponse(functionsRecord, this.baseUrl);
  }
}
