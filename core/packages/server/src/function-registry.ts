/**
 * FunctionRegistry - Internal storage for function definitions
 *
 * This class manages the registration and retrieval of function definitions.
 * It provides a simple in-memory store with basic CRUD operations.
 *
 * Design rationale:
 * - Uses Map for O(1) lookup performance (critical for high-traffic scenarios)
 * - Allows overwriting to support function updates during development
 * - Returns copies of internal state to prevent external mutation
 */

import {
  normalizeFunctionDefinition,
  normalizeMoonBitAbi,
  type FunctionDefinition,
} from '@unzen/shared';

function copyDefinition(definition: FunctionDefinition): FunctionDefinition {
  const moonbitAbi = definition.moonbitAbi === undefined
    ? undefined
    : normalizeMoonBitAbi(definition.moonbitAbi);

  return {
    name: definition.name,
    runtime: definition.runtime,
    code: definition.code,
    version: definition.version,
    hash: definition.hash,
    ...(definition.exportName !== undefined && { exportName: definition.exportName }),
    ...(moonbitAbi !== undefined && { moonbitAbi }),
    ...(definition.timeout !== undefined && { timeout: definition.timeout }),
    ...(definition.noFallback !== undefined && { noFallback: definition.noFallback }),
  };
}

export class FunctionRegistry {
  /**
   * Internal storage for function definitions
   * Key: function name, Value: function definition
   */
  private functions: Map<string, FunctionDefinition>;

  constructor() {
    this.functions = new Map();
  }

  /**
   * Register a function definition
   *
   * If a function with the same name already exists, it will be overwritten.
   * This allows for function updates during development.
   *
   * @param def - Function definition to register
   */
  register(def: FunctionDefinition): void {
    const snapshot = normalizeFunctionDefinition(def);
    if (snapshot === undefined) {
      throw new TypeError('Invalid function definition');
    }
    this.functions.set(snapshot.name, snapshot);
  }

  /**
   * Retrieve a function definition by name
   *
   * @param name - Function name
   * @returns Function definition if found, undefined otherwise
   */
  get(name: string): FunctionDefinition | undefined {
    const definition = this.functions.get(name);
    return definition === undefined
      ? undefined
      : copyDefinition(definition);
  }

  /**
   * Check if a function is registered
   *
   * @param name - Function name
   * @returns true if function exists, false otherwise
   */
  has(name: string): boolean {
    return this.functions.has(name);
  }

  /**
   * Get all registered functions
   *
   * Returns a copy of the map and every definition value, including nested ABI
   * metadata, to prevent external modification of registry-owned state.
   *
   * @returns Copy of the internal function map
   */
  getAll(): Map<string, FunctionDefinition> {
    const definitions = new Map<string, FunctionDefinition>();
    for (const [name, definition] of this.functions) {
      definitions.set(name, copyDefinition(definition));
    }
    return definitions;
  }
}
